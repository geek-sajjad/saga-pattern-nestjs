import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Engine } from 'bpmn-engine';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Subject } from 'rxjs';
import { Repository } from 'typeorm';
import { Deployment, HistoryEntry, Incident, ProcessInstance, Wait } from './entities';
import { evaluate, libraryExpressions } from './expressions';
import { BpmnError, HandlerRegistry } from './handlers';
import { MINI_MODDLE } from './mini-moddle';
import { ACTIVITY_TYPES, NodeInfo, ProcessModel, readProcessModel } from './process-model';

export type EngineEvent = { type: 'instance'; instanceId: string } | { type: 'deployed'; key: string; version: number };

/** bpmn-engine's element API objects (what its events carry) are untyped JavaScript as far as we're concerned. */
type ElementApi = any;

/** An instance that bpmn-engine is executing right now, plus our bookkeeping around it. */
interface LiveInstance {
  record: ProcessInstance;
  model: ProcessModel;
  engine: Engine;
  waits: Map<string, Wait>;
  /** Call activities waiting for a child instance, by execution id. Used to signal them when the child ends. */
  calls: Map<string, ElementApi>;
  /** How to try a parked activity again (a failed handler, a failed compensation, a call that couldn't start). */
  retries: Map<string, () => void>;
  /** Handler calls in flight. Compensation waits for them: an interrupted call may still have booked something. */
  inflight: Set<Promise<void>>;
  /** Error codes caught by a boundary event; an error end event whose code isn't here was not caught. */
  caughtErrors: string[];
  /** An error end event nothing caught: bpmn-engine just ends the process, we end it as TERMINATED. */
  uncaughtError?: { code: string; message: string };
  /** True while bpmn-engine replays a restored snapshot: it re-emits waits and timers we already recorded. */
  replaying: boolean;
  ended: boolean;
  dirty: boolean;
  saving?: Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pick = (vars: Record<string, any>, names: string[]) => Object.fromEntries(names.filter((n) => n in vars).map((n) => [n, vars[n]]));

/**
 * The process engine, built on bpmn-engine (github.com/paed01/bpmn-engine).
 *
 * bpmn-engine executes BPMN 2.0: it walks tokens through the graph, evaluates
 * gateways, runs timers, joins parallel branches, routes errors to boundary
 * events and loops multi-instance activities. It does all of that in memory
 * and tells us what happens through events.
 *
 * This service is the "platform" around it, the part every product built on
 * a BPMN library has to add itself:
 *
 *   deployments & versions   → Deployment table; each instance runs on the version it started with
 *   persistence & restarts   → after every event, save bpmn-engine's snapshot; on boot, recover() + resume()
 *   service tasks            → `mini:handler="ocean.book"` calls code from the HandlerRegistry
 *   incidents                → a handler that fails technically parks its task until an operator retries
 *   messages & correlation   → `POST /api/messages {name, correlationKey}` finds the waiting instance
 *   call activities          → start a separate, separately versioned instance, and report back when it ends
 *   compensation             → undo completed activities, newest first, one at a time
 */
@Injectable()
export class BpmnEngine implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('bpmn-engine');
  private readonly models = new Map<string, ProcessModel>();
  private readonly live = new Map<string, LiveInstance>();
  /** Observability only (the UI listens to it); the engine never depends on it. */
  readonly events = new Subject<EngineEvent>();

  constructor(
    @InjectRepository(Deployment) private readonly deployments: Repository<Deployment>,
    @InjectRepository(ProcessInstance) private readonly instances: Repository<ProcessInstance>,
    private readonly handlers: HandlerRegistry,
  ) {}

  async onApplicationBootstrap() {
    // Pick up every instance that was running when the process stopped.
    for (const record of await this.instances.findBy({ status: 'RUNNING' })) {
      try {
        await this.resume(record);
      } catch (err) {
        this.log.error(`cannot resume instance ${record.id}: ${errorMessage(err)}`);
      }
    }
  }

  async onModuleDestroy() {
    // Stop timers and handlers; the saved snapshots let the next start continue where we left off.
    for (const live of this.live.values()) {
      live.ended = true;
      await live.engine.stop();
    }
  }

  // ───────────────────────────── deployment & versions ─────────────────────────────

  /** Validate and store a BPMN file. XML that is already deployed (as ANY version) creates no new version. */
  async deploy(xml: string): Promise<Deployment> {
    const model = await readProcessModel(xml); // throws BpmnValidationError with a list of problems
    const same = await this.deployments.findOneBy({ key: model.key, xml });
    if (same) return same;

    const latest = await this.latestDeployment(model.key);
    const deployment = await this.deployments.save(
      this.deployments.create({ key: model.key, name: model.name, version: (latest?.version ?? 0) + 1, versionTag: model.versionTag ?? null, xml }),
    );
    this.log.log(`deployed ${deployment.key} v${deployment.version}${deployment.versionTag ? ` (${deployment.versionTag})` : ''}`);
    this.events.next({ type: 'deployed', key: deployment.key, version: deployment.version });
    return deployment;
  }

  /** Every version of every process, with how many instances still run on it. */
  async listDeployments() {
    const all = await this.deployments.find({ order: { key: 'ASC', version: 'DESC' } });
    const counts: { key: string; version: number; running: number }[] = await this.instances
      .createQueryBuilder('i')
      .select('i.definitionKey', 'key')
      .addSelect('i.definitionVersion', 'version')
      .addSelect('COUNT(*)', 'running')
      .where('i.status = :status', { status: 'RUNNING' })
      .groupBy('i.definitionKey')
      .addGroupBy('i.definitionVersion')
      .getRawMany();
    return all.map(({ xml, ...rest }) => ({
      ...rest,
      running: Number(counts.find((c) => c.key === rest.key && Number(c.version) === rest.version)?.running ?? 0),
    }));
  }

  async getDeployment(key: string, version?: number): Promise<Deployment> {
    const d = version ? await this.deployments.findOneBy({ key, version }) : await this.latestDeployment(key);
    if (!d) throw new NotFoundException(`process ${key}${version ? ` v${version}` : ''} is not deployed`);
    return d;
  }

  /** The newest deployment carrying a version tag (redeploying a tag moves it forward, like a git tag you re-point). */
  async getDeploymentByTag(key: string, versionTag: string): Promise<Deployment> {
    const d = await this.deployments.findOne({ where: { key, versionTag }, order: { version: 'DESC' } });
    if (!d) throw new NotFoundException(`process ${key} has no version tagged "${versionTag}"`);
    return d;
  }

  async model(key: string, version: number): Promise<ProcessModel> {
    const cacheKey = `${key}@${version}`;
    let model = this.models.get(cacheKey);
    if (!model) {
      model = await readProcessModel((await this.getDeployment(key, version)).xml);
      this.models.set(cacheKey, model);
    }
    return model;
  }

  /** What changed between two versions. */
  async diff(key: string, from: number, to: number) {
    const [a, b] = [await this.model(key, from), await this.model(key, to)];
    const describe = (n: NodeInfo) => ({ id: n.id, type: n.type, name: n.name });
    const differs = (x: NodeInfo, y: NodeInfo) => x.type !== y.type || x.name !== y.name || x.parentId !== y.parentId || x.handler !== y.handler || !!x.loop !== !!y.loop;
    return {
      key,
      from: { version: from, versionTag: a.versionTag },
    to: { version: to, versionTag: b.versionTag },
      added: Object.values(b.nodes).filter((n) => !a.nodes[n.id]).map(describe),
      removed: Object.values(a.nodes).filter((n) => !b.nodes[n.id]).map(describe),
      changed: Object.values(b.nodes).filter((n) => a.nodes[n.id] && differs(a.nodes[n.id], n)).map((n) => ({ from: describe(a.nodes[n.id]), to: describe(n) })),
    };
  }

  private latestDeployment(key: string) {
    return this.deployments.findOne({ where: { key }, order: { version: 'DESC' } });
  }

  // ───────────────────────────── public API ─────────────────────────────

  /**
   * Start an instance. By default the LATEST version, which is what callers
   * almost always want; pass a version or a version tag to pin an older one.
   */
  async start(key: string, variables: Record<string, unknown> = {}, pin: { version?: number; versionTag?: string } = {}): Promise<ProcessInstance> {
    const deployment = pin.versionTag ? await this.getDeploymentByTag(key, pin.versionTag) : await this.getDeployment(key, pin.version);
    return this.startInstance(deployment, variables);
  }

  /** A person finished a user task: merge the form data and signal the task. */
  async completeUserTask(instanceId: string, tokenId: string, data: Record<string, unknown> = {}) {
    const live = this.running(instanceId);
    const wait = live.waits.get(tokenId);
    if (wait?.kind !== 'user') throw new ConflictException(`token ${tokenId} is not waiting at a user task`);
    const node = live.model.nodes[wait.nodeId];
    let result: unknown = data;
    if (wait.iteration) {
      // One iteration of a multi-instance task: its result goes into the loop's output, not into the process variables.
      const loop = node.loop!;
      result = loop.outputElement ? evaluate(loop.outputElement, { ...live.record.variables, ...this.iterationLocals(node, wait.iteration), ...data }) : data;
    } else {
      Object.assign(live.record.variables, data);
    }
    live.waits.delete(tokenId);
    this.record(live, { type: 'task-completed', nodeId: node.id, tokenId, message: `completed by a user with ${JSON.stringify(data)}` });
    live.engine.execution!.signal({ id: node.id, executionId: tokenId, result });
    this.persist(live);
  }

  /**
   * An external system tells the engine something happened ("vessel arrived").
   * The engine delivers it to every instance waiting for that message name
   * and, if the wait has one, the same correlation key.
   * (Camunda 7: RuntimeService.createMessageCorrelation; Zeebe: PublishMessage.)
   * Unlike Zeebe we don't buffer: a message nobody waits for is dropped.
   */
  async correlateMessage(name: string, correlationKey?: string, variables: Record<string, unknown> = {}) {
    const correlated: string[] = [];
    for (const live of [...this.live.values()]) {
      const wait = [...live.waits.values()].find(
        (w) => w.kind === 'message' && w.messageName === name && (correlationKey === undefined || w.correlationKey === undefined || w.correlationKey === String(correlationKey)),
      );
      if (!wait) continue;
      Object.assign(live.record.variables, variables);
      // bpmn-engine routes a signal carrying the <bpmn:message> id to whatever waits for that message.
      live.engine.execution!.signal({ id: wait.messageId });
      correlated.push(live.record.id);
      this.persist(live);
    }
    return { name, correlationKey, correlated };
  }

  /** An operator fixed the cause of an incident (e.g. restarted a service): try the activity again. */
  async retryIncident(instanceId: string, tokenId: string) {
    const live = this.running(instanceId);
    const incident = live.record.incidents.find((i) => i.executionId === tokenId);
    const retry = live.retries.get(tokenId);
    if (!incident || !retry) throw new ConflictException(`token ${tokenId} has no incident`);
    live.record.incidents = live.record.incidents.filter((i) => i !== incident);
    this.record(live, { type: 'incident-retried', nodeId: incident.nodeId, tokenId, message: 'retrying after incident' });
    retry();
    this.persist(live);
  }

  /** Operators can fix data before a retry (e.g. correct a wrong address). Replaces the variables wholesale. */
  async setVariables(instanceId: string, variables: Record<string, unknown>) {
    const live = this.running(instanceId);
    // Replace the contents, not the object: expressions and handlers hold on to it.
    for (const key of Object.keys(live.record.variables)) delete live.record.variables[key];
    Object.assign(live.record.variables, variables);
    this.record(live, { type: 'variables-changed', message: 'variables edited by an operator' });
    this.persist(live);
  }

  /** Stop an instance and every instance it called. Nothing is compensated. */
  async cancel(instanceId: string, reason = 'cancelled by an operator') {
    const live = this.running(instanceId);
    live.ended = true;
    await live.engine.stop();
    await this.finish(live, 'CANCELLED', reason);
  }

  async listInstances() {
    return (await this.instances.find({ order: { createdAt: 'DESC' }, take: 100 })).map((i) => this.live.get(i.id)?.record ?? i);
  }

  children(instanceId: string) {
    return this.instances.find({ where: { parentInstanceId: instanceId }, order: { createdAt: 'ASC' } });
  }

  async getInstance(id: string): Promise<ProcessInstance> {
    const live = this.live.get(id);
    if (live) return live.record;
    const instance = await this.instances.findOneBy({ id });
    if (!instance) throw new NotFoundException(`instance ${id} not found`);
    return instance;
  }

  private running(instanceId: string): LiveInstance {
    const live = this.live.get(instanceId);
    if (!live || live.ended) throw new ConflictException(`instance ${instanceId} is not running`);
    return live;
  }

  // ───────────────────────────── running instances on bpmn-engine ─────────────────────────────

  private async startInstance(deployment: Deployment, variables: Record<string, unknown>, parent?: { instanceId: string; executionId: string }) {
    const record = this.instances.create({
      id: randomUUID(),
      definitionKey: deployment.key,
      definitionVersion: deployment.version,
      status: 'RUNNING',
      parentInstanceId: parent?.instanceId ?? null,
      parentExecutionId: parent?.executionId ?? null,
      endError: null,
      engineState: null,
      waits: [],
      incidents: [],
      variables,
      completed: [],
      history: [],
    });
    const tag = deployment.versionTag ? ` (${deployment.versionTag})` : '';
    this.pushHistory(record, { type: 'instance-started', message: `started ${deployment.name} v${deployment.version}${tag}${parent ? `, called by instance ${parent.instanceId.slice(0, 8)}` : ''}` });
    await this.instances.save(record);

    const live = this.createLive(record, await this.model(deployment.key, deployment.version), deployment.xml);
    await live.engine.execute({ listener: this.listener(live) });
    this.persist(live);
    return record;
  }

  /** Rebuild a running instance from its saved snapshot. Its timers continue with the time they had left. */
  private async resume(record: ProcessInstance) {
    const deployment = await this.getDeployment(record.definitionKey, record.definitionVersion);
    const live = this.createLive(record, await this.model(record.definitionKey, record.definitionVersion), deployment.xml);
    live.replaying = true;
    if (record.engineState) {
      live.engine.recover(record.engineState as any);
      await live.engine.resume({ listener: this.listener(live) });
    } else {
      // We crashed before the first snapshot was saved: start from the beginning.
      await live.engine.execute({ listener: this.listener(live) });
    }
    live.replaying = false;
    this.log.log(`resumed instance ${record.id}`);
    this.persist(live);
  }

  /** One bpmn-engine Engine per instance, wired to our handlers, expressions and compensation. */
  private createLive(record: ProcessInstance, model: ProcessModel, xml: string): LiveInstance {
    const live = {
      record,
      model,
      waits: new Map(record.waits.map((w) => [w.executionId, w])),
      calls: new Map(),
      retries: new Map(),
      inflight: new Set(),
      caughtErrors: [],
      replaying: false,
      ended: false,
      dirty: false,
    } as Omit<LiveInstance, 'engine'> as LiveInstance;

    live.engine = new Engine({
      name: record.id,
      source: xml,
      moddleOptions: { mini: MINI_MODDLE },
      // `${…}` is JavaScript over the process variables (plus the item, inside a multi-instance iteration).
      expressions: libraryExpressions((context) => ({ ...record.variables, ...this.localsOf(live, context?.content) })),
      // Every service task runs its `mini:handler` through the HandlerRegistry.
      extensions: {
        mini: (activity: ElementApi) => {
          if (activity.type === 'bpmn:ServiceTask') activity.behaviour.Service = this.handlerService(live);
        },
      },
      // bpmn-elements' own compensation only reaches activities in the scope that throws it, and starts
      // all undo tasks at once. We swap in ours: newest first, one at a time, an incident if an undo fails.
      elements: { CompensateEventDefinition: this.compensationBehaviour(live) },
    });
    live.engine.once('end', () => void (live.uncaughtError ? this.finish(live, 'TERMINATED', undefined, live.uncaughtError) : this.finish(live, 'COMPLETED')));
    live.engine.once('error', (err: any) => {
      const code = err?.code ?? err?.inner?.code;
      void this.finish(live, 'TERMINATED', undefined, { code: code ? String(code) : 'ERROR', message: err?.description ?? errorMessage(err) });
    });
    this.live.set(record.id, live);
    return live;
  }

  /** bpmn-engine reports everything through a listener. This is where its events become our history and waits. */
  private listener(live: LiveInstance) {
    const listener = new EventEmitter();
    listener.emit = (eventName: string | symbol, api: ElementApi) => {
      if (!live.ended) {
        try {
          this.onEngineEvent(live, String(eventName), api);
        } catch (err) {
          this.log.error(`[${live.record.id.slice(0, 8)}] ${String(eventName)}: ${errorMessage(err)}`);
        }
      }
      return true;
    };
    return listener;
  }

  private onEngineEvent(live: LiveInstance, eventName: string, api: ElementApi) {
    const content = api.content ?? {};
    const node = live.model.nodes[api.id];
    const label = (id: string) => live.model.nodes[id]?.name ?? id;
    const isIteration = content.isMultiInstance && !content.isRootScope;

    switch (eventName) {
      case 'flow.take': {
        const flow = live.model.flows[api.id];
        if (flow) this.record(live, { type: 'flow-taken', flowId: flow.id, message: `→ ${label(flow.targetRef)}${flow.name ? ` (${flow.name})` : ''}` });
        break;
      }

      case 'activity.start':
        // A parallel join is "entered" by its first branch, then waits for the others.
        if (node?.type === 'parallelGateway' && node.incoming.length > 1) this.setWait(live, { executionId: api.executionId, nodeId: node.id, kind: 'join' });
        break;

      case 'activity.wait': {
        if (!node) break;
        const iteration = isIteration ? { index: content.index, item: content[node.loop!.elementVariable] } : undefined;
        if (node.type === 'userTask') {
          this.setWait(live, { executionId: api.executionId, nodeId: node.id, kind: 'user', scopeId: isIteration ? content.parent?.executionId : undefined, iteration });
          this.record(live, { type: 'waiting', nodeId: node.id, tokenId: api.executionId, message: `waiting for a person to complete "${label(node.id)}"${iteration ? ` (item #${iteration.index + 1})` : ''}` });
        } else if (node.message) {
          this.subscribe(live, node, api.executionId);
        }
        break;
      }

      case 'activity.timer': {
        // The timer runs on the event definition; the wait belongs to the event (its parent execution).
        const executionId = content.parent?.executionId ?? api.executionId;
        this.setWait(live, { executionId, nodeId: api.id, kind: 'timer', dueAt: new Date(content.expireAt).getTime(), interrupting: node?.interrupting });
        this.record(live, { type: 'waiting', nodeId: api.id, tokenId: executionId, message: `timer set${content.timeout ? ` for ${content.timeout / 1000}s` : ''}${node?.attachedTo ? ` on "${label(node.attachedTo)}"` : ''}` });
        break;
      }

      case 'activity.timeout':
        this.record(live, { type: 'timer-fired', nodeId: api.id, message: `timer "${label(api.id)}" fired${node?.interrupting === false ? ' (non-interrupting)' : ''}` });
        break;

      case 'activity.throw':
        // An error end event. bpmn-engine announces the catch (if any) before the throw.
        if (content.message?.type === 'bpmn:Error') {
          const code = String(content.message.code);
          const caught = live.caughtErrors.indexOf(code);
          if (caught >= 0) live.caughtErrors.splice(caught, 1);
          else live.uncaughtError = { code, message: `end event "${label(api.id)}" threw ${code}` };
        }
        break;

      case 'activity.catch':
        if (content.error) {
          if (content.error.code) {
            // Only matters to an `activity.throw` that follows in the same tick (see above).
            const code = String(content.error.code);
            live.caughtErrors.push(code);
            setImmediate(() => live.caughtErrors.includes(code) && live.caughtErrors.splice(live.caughtErrors.indexOf(code), 1));
          }
          // Handlers that undo things want to know why (`variables.lastError`).
          live.record.variables.lastError = { code: content.error.code, message: content.error.message ?? content.error.description, nodeId: content.error.source?.content?.id };
          this.record(live, { type: 'error-caught', nodeId: api.id, message: `"${label(node?.attachedTo ?? api.id)}" caught ${content.error.code ?? 'an error'}: ${content.error.message ?? content.error.description}` });
        } else if (node?.message) {
          this.record(live, { type: 'message-received', nodeId: api.id, message: `message "${node.message.name}" received` });
        }
        break;

      case 'activity.call':
        void this.onCallActivity(live, api);
        break;

      case 'activity.call.cancel': {
        // The call activity was interrupted (boundary event, error, cancel): the child is no longer needed.
        const childId = live.waits.get(api.executionId)?.childInstanceId;
        if (childId) void this.cancel(childId, `cancelled because the calling instance ${live.record.id.slice(0, 8)} no longer needs it`).catch(() => undefined);
        break;
      }

      case 'activity.end':
        if (!node) break;
        if (content.isRootScope && ACTIVITY_TYPES.includes(node.type) && !node.isForCompensation) {
          live.record.completed.push({ nodeId: node.id, at: new Date().toISOString() });
        }
        if (content.isRootScope && node.loop?.outputCollection) {
          // bpmn-engine collects one output per iteration; user task iterations carry theirs as `result`.
          const outputs: unknown[] = content.output ?? [];
          live.record.variables[node.loop.outputCollection] = outputs.map((o: any) => (node.type === 'userTask' ? o?.result : o));
        }
        this.removeWaits(live, api.executionId);
        this.record(live, { type: 'node-completed', nodeId: node.id, tokenId: api.executionId, message: `${node.type} "${label(node.id)}" done` });
        break;

      case 'activity.leave':
      case 'activity.discard':
        this.removeWaits(live, api.executionId);
        break;

      default:
        return; // nothing changed that we keep
    }
    this.persist(live);
  }

  /** A message wait: the correlation key is evaluated NOW, against the current variables. */
  private subscribe(live: LiveInstance, node: NodeInfo, executionId: string) {
    const { id, name, correlationKey } = node.message!;
    let key: unknown;
    try {
      key = correlationKey ? evaluate(correlationKey, live.record.variables) : undefined;
    } catch (err) {
      this.log.warn(`[${live.record.id.slice(0, 8)}] correlation key ${correlationKey} of ${node.id}: ${errorMessage(err)}`);
    }
    this.setWait(live, { executionId, nodeId: node.id, kind: 'message', messageId: id, messageName: name, correlationKey: key == null ? undefined : String(key), interrupting: node.interrupting });
    this.record(live, { type: 'waiting', nodeId: node.id, tokenId: executionId, message: `waiting for message "${name}"${key == null ? '' : ` with key ${key}`}` });
  }

  // ───────────────────────────── service tasks & incidents ─────────────────────────────

  /**
   * The service behind every service task (bpmn-elements calls it with the
   * task's execute message and a callback). The diagram says WHAT happens; the
   * handler named in `mini:handler` says HOW.
   */
  private handlerService(live: LiveInstance) {
    const engine = this;
    return class HandlerService {
      private executionId?: string;
      constructor(private readonly activity: ElementApi) {}
      execute(executeMessage: ElementApi, callback: (err: Error | null, output?: unknown) => void) {
        this.executionId = executeMessage.content.executionId;
        engine.runHandler(live, this.activity.id, executeMessage.content, callback);
      }
      /** bpmn-elements discards a running task when something interrupts it; its handler may still be running. */
      discard() {
        if (this.executionId) engine.removeWaits(live, this.executionId);
      }
    };
  }

  private runHandler(live: LiveInstance, nodeId: string, content: any, callback: (err: Error | null, output?: unknown) => void) {
    const node = live.model.nodes[nodeId];
    const executionId: string = content.executionId;
    const isIteration = content.isMultiInstance && !content.isRootScope;
    const attempt = () => {
      live.retries.delete(executionId);
      // Tracked until its outcome is booked, so compensation can wait for calls that are still out.
      const run = call().catch((err) => this.log.error(`[${live.record.id.slice(0, 8)}] ${nodeId}: ${errorMessage(err)}`));
      live.inflight.add(run);
      void run.finally(() => live.inflight.delete(run));
    };

    const call = async () => {
      const handler = this.handlers.get(node.handler ?? '');
      if (!handler) return this.incident(live, executionId, node, `no handler registered for "${node.handler}"`, attempt);

      this.setWait(live, { executionId, nodeId, kind: 'executing' });
      this.record(live, { type: 'node-entered', nodeId, tokenId: executionId, message: `calling handler "${node.handler}"${isIteration ? ` for item #${content.index + 1}` : ''}` });
      this.persist(live);

      const locals = this.localsOf(live, content);
      let result: Record<string, unknown> | void = undefined;
      let failure: unknown = undefined;
      try {
        result = await handler({ instanceId: live.record.id, nodeId, variables: structuredClone({ ...live.record.variables, ...locals }) });
      } catch (err) {
        failure = err ?? new Error('handler failed');
      }
      // bpmn-elements expects the callback on a later tick (compensation and joins misbehave on synchronous completion).
      // Decide what happened only then: the task may have been interrupted in the meantime.
      await new Promise((resolve) => setImmediate(resolve));
      if (live.ended) return;

      if (!live.waits.has(executionId)) {
        // The task was interrupted while its handler ran (an error in a parallel branch, an interrupting
        // boundary event). If the work still happened, record it: compensation must undo it.
        if (failure) return this.log.warn(`[${live.record.id.slice(0, 8)}] ${nodeId} failed after it was interrupted: ${errorMessage(failure)}`);
        if (!isIteration) {
          live.record.completed.push({ nodeId, at: new Date().toISOString() });
          if (result) Object.assign(live.record.variables, result);
        }
        this.record(live, { type: 'node-completed', nodeId, tokenId: executionId, message: `handler "${node.handler}" finished after the task was interrupted; kept so compensation can undo it` });
        return this.persist(live);
      }
      if (failure) {
        // A business error: bpmn-engine routes it to the error boundary event whose errorCode matches.
        if (failure instanceof BpmnError) return callback(Object.assign(new Error(failure.message), { code: failure.code }));
        // Anything else is not modelled in the diagram: a technical problem for a human.
        return this.incident(live, executionId, node, errorMessage(failure), attempt);
      }
      if (isIteration) {
        // An iteration's result belongs to the loop (outputCollection), so parallel iterations don't overwrite each other.
        let output: unknown;
        try {
          output = node.loop?.outputElement ? evaluate(node.loop.outputElement, { ...live.record.variables, ...locals, ...(result ?? {}) }) : (result ?? {});
        } catch (err) {
          return this.incident(live, executionId, node, `mini:outputElement ${node.loop?.outputElement} failed: ${errorMessage(err)}`, attempt);
        }
        return callback(null, output);
      }
      if (result) Object.assign(live.record.variables, result);
      callback(null, result ?? undefined);
    };

    if (live.record.incidents.some((i) => i.executionId === executionId)) {
      live.retries.set(executionId, attempt); // parked before a restart; it stays parked until someone retries
    } else {
      if (live.replaying) this.record(live, { type: 'incident-retried', nodeId, tokenId: executionId, message: 'engine restarted while this handler was running: executing it again (at-least-once)' });
      void attempt();
    }
  }

  private incident(live: LiveInstance, executionId: string, node: NodeInfo, message: string, retry: () => void) {
    live.record.incidents = [...live.record.incidents.filter((i) => i.executionId !== executionId), { executionId, nodeId: node.id, message, at: new Date().toISOString() } satisfies Incident];
    live.retries.set(executionId, retry);
    this.record(live, { type: 'incident', nodeId: node.id, tokenId: executionId, message });
    this.log.warn(`[${live.record.id.slice(0, 8)}] incident at ${node.id}: ${message}`);
    this.persist(live);
  }

  // ───────────────────────────── compensation ─────────────────────────────

  /**
   * Replaces bpmn-elements' CompensateEventDefinition.
   *  - On a compensation BOUNDARY event it does nothing, so the event simply
   *    ends with its activity: we know what to undo from `completed`.
   *  - On a compensation THROW event it runs the undo handlers and only then
   *    lets the token continue.
   */
  private compensationBehaviour(live: LiveInstance) {
    const engine = this;
    return class Compensation {
      readonly id: string;
      constructor(private readonly activity: ElementApi, eventDefinition: ElementApi) {
        this.id = activity.id;
        (this as any).type = eventDefinition.type;
      }
      execute(executeMessage: ElementApi) {
        if (!this.activity.isThrowing) return;
        const content = executeMessage.content;
        engine.compensate(live, this.activity.id, content.parent?.executionId ?? content.executionId).then(
          () => !live.ended && this.activity.broker.publish('execution', 'execute.completed', { ...content }),
        );
      }
    };
  }

  /**
   * Compensation = BPMN's built-in saga. Walk the COMPLETED activities
   * backwards and run the compensation handler of each one that has one.
   * Activities that never completed (e.g. the one that just failed) are not
   * compensated: there is nothing to undo. Resolves once everything is undone.
   */
  private compensate(live: LiveInstance, throwNodeId: string, executionId: string): Promise<void> {
    const node = live.model.nodes[throwNodeId];
    return new Promise((resolve) => {
      const attempt = async () => {
        live.retries.delete(executionId);
        this.setWait(live, { executionId, nodeId: throwNodeId, kind: 'executing' });
        // Parallel branches may still be calling out (bpmn-engine really runs them at the same time).
        // Wait for them: what they book has to be undone too.
        await Promise.all([...live.inflight]);
        if (live.ended) return;
        const todo = [...live.record.completed].reverse().filter((c) => !c.compensated && live.model.nodes[c.nodeId]?.compensatedBy);
        this.record(live, { type: 'compensation-started', nodeId: throwNodeId, tokenId: executionId, message: `undoing ${todo.length} completed activit${todo.length === 1 ? 'y' : 'ies'} in reverse order` });
        this.persist(live);

        for (const done of todo) {
          const undo = live.model.nodes[live.model.nodes[done.nodeId].compensatedBy!];
          const handler = this.handlers.get(undo.handler ?? '');
          if (!handler) return this.incident(live, executionId, node, `compensation task "${undo.name}" has no registered handler "${undo.handler}"`, attempt);
          try {
            const result = await handler({ instanceId: live.record.id, nodeId: undo.id, variables: structuredClone(live.record.variables) });
            if (live.ended) return;
            if (result) Object.assign(live.record.variables, result);
          } catch (err) {
            if (live.ended) return;
            // A compensation must eventually succeed: stop here, an operator retries (already-undone steps are skipped).
            return this.incident(live, executionId, node, `compensation "${undo.name}" failed: ${errorMessage(err)}`, attempt);
          }
          done.compensated = true;
          this.record(live, { type: 'compensated', nodeId: undo.id, message: `"${undo.name}" undid "${live.model.nodes[done.nodeId].name}"` });
          this.persist(live);
        }
        this.removeWaits(live, executionId);
        resolve();
      };
      if (live.record.incidents.some((i) => i.executionId === executionId)) live.retries.set(executionId, attempt);
      else void attempt();
    });
  }

  // ───────────────────────────── call activities ─────────────────────────────

  /**
   * bpmn-engine reached a call activity. It can only call processes from the
   * same file, so it waits and leaves the rest to us: start a separate
   * instance of the called process, in the version the binding picks.
   */
  private async onCallActivity(live: LiveInstance, api: ElementApi) {
    const node = live.model.nodes[api.id];
    const executionId: string = api.executionId;
    live.calls.set(executionId, api);
    this.setWait(live, { executionId, nodeId: node.id, kind: 'call' });

    if (live.record.incidents.some((i) => i.executionId === executionId)) {
      live.retries.set(executionId, () => void this.startChild(live, node, executionId));
      return;
    }
    // After a restart bpmn-engine reaches the call activity again: reuse the child we started before.
    const [existing] = await this.instances.find({ where: { parentInstanceId: live.record.id, parentExecutionId: executionId }, order: { createdAt: 'DESC' }, take: 1 });
    if (existing) {
      this.setWait(live, { executionId, nodeId: node.id, kind: 'call', childInstanceId: existing.id });
      if (existing.status !== 'RUNNING') this.onChildEnded(live, this.live.get(existing.id)?.record ?? existing);
      return;
    }
    await this.startChild(live, node, executionId);
  }

  private async startChild(live: LiveInstance, node: NodeInfo, executionId: string) {
    const vars = live.record.variables;
    const call = node.call!;
    let deployment: Deployment;
    try {
      const ref = call.calledVersion?.startsWith('${') ? String(evaluate(call.calledVersion, vars)) : call.calledVersion;
      deployment =
        call.binding === 'versionTag' ? await this.getDeploymentByTag(call.calledElement, ref!)
        : await this.getDeployment(call.calledElement, call.binding === 'version' ? Number(ref) : undefined);
    } catch (err) {
      return this.incident(live, executionId, node, `cannot call "${call.calledElement}": ${errorMessage(err)}`, () => void this.startChild(live, node, executionId));
    }
    const child = await this.startInstance(deployment, structuredClone(call.inputs ? pick(vars, call.inputs) : vars), { instanceId: live.record.id, executionId });
    if (live.ended) return;
    this.setWait(live, { executionId, nodeId: node.id, kind: 'call', childInstanceId: child.id });
    const label = `${deployment.key} v${deployment.version}${deployment.versionTag ? ` (${deployment.versionTag})` : ''}`;
    this.record(live, { type: 'called', nodeId: node.id, tokenId: executionId, message: `started ${label} as instance ${child.id.slice(0, 8)} (binding: ${call.binding}${call.calledVersion ? ` ${call.calledVersion}` : ''})` });
    this.persist(live);
  }

  /** A called instance completed, was terminated by an error, or was cancelled: continue the parent. */
  private onChildEnded(parent: LiveInstance, child: ProcessInstance) {
    const executionId = child.parentExecutionId!;
    const api = parent.calls.get(executionId);
    if (!api || parent.ended) return; // the call was interrupted meanwhile
    const node = parent.model.nodes[api.id];
    const short = child.id.slice(0, 8);

    if (child.status === 'COMPLETED') {
      Object.assign(parent.record.variables, structuredClone(node.call!.outputs ? pick(child.variables, node.call!.outputs) : child.variables));
      parent.calls.delete(executionId);
      api.signal({});
    } else if (child.status === 'TERMINATED' && child.endError) {
      // The child's uncaught BPMN error lands on this call activity, where an error boundary can catch it.
      parent.calls.delete(executionId);
      api.sendApiMessage('error', { message: `called process: ${child.endError.message}`, code: child.endError.code });
    } else {
      this.incident(parent, executionId, node, `called instance ${short} was ${child.status.toLowerCase()}; retry starts a new one`, () => void this.startChild(parent, node, executionId));
    }
    this.persist(parent);
  }

  // ───────────────────────────── bookkeeping ─────────────────────────────

  /** The instance ended: COMPLETED (an end event), TERMINATED (an uncaught error) or CANCELLED (an operator). */
  private async finish(live: LiveInstance, status: ProcessInstance['status'], reason?: string, endError?: { code: string; message: string }) {
    if (live.record.status !== 'RUNNING') return;
    live.ended = true;
    const record = live.record;
    record.status = status;
    record.endError = endError ?? null;
    live.waits.clear();
    record.incidents = [];
    if (status === 'COMPLETED') this.pushHistory(record, { type: 'instance-completed', message: 'completed' });
    if (status === 'CANCELLED') this.pushHistory(record, { type: 'instance-cancelled', message: reason ?? 'cancelled' });
    if (status === 'TERMINATED') {
      const handedOver = record.parentInstanceId ? '; handing it to the calling process' : '';
      this.pushHistory(record, { type: 'instance-terminated', message: `nothing caught ${endError?.code}: ${endError?.message}${handedOver}` });
      this.log.warn(`[${record.id.slice(0, 8)}] terminated: ${endError?.code} ${endError?.message}`);
    }
    this.persist(live);
    await live.saving;
    this.live.delete(record.id);

    // Called instances end with the instance that called them.
    for (const child of await this.instances.findBy({ parentInstanceId: record.id, status: 'RUNNING' })) {
      await this.cancel(child.id, `cancelled because the calling instance ${record.id.slice(0, 8)} ended`).catch(() => undefined);
    }
    const parent = record.parentInstanceId ? this.live.get(record.parentInstanceId) : undefined;
    if (parent) this.onChildEnded(parent, record);
  }

  private setWait(live: LiveInstance, wait: Wait) {
    const previous = live.waits.get(wait.executionId);
    live.waits.set(wait.executionId, previous?.childInstanceId && !wait.childInstanceId ? { ...wait, childInstanceId: previous.childInstanceId } : wait);
  }

  /** An execution left: forget its wait, and those of any multi-instance iterations under it. */
  removeWaits(live: LiveInstance, executionId: string) {
    for (const [id, wait] of live.waits) if (id === executionId || wait.scopeId === executionId) live.waits.delete(id);
  }

  /** Inside a multi-instance iteration, code also sees the item (`mini:elementVariable`) and `loopCounter`. */
  private localsOf(live: LiveInstance, content: any): Record<string, unknown> {
    if (!content?.isMultiInstance || content.isRootScope) return {};
    const node = live.model.nodes[content.id];
    return node?.loop ? this.iterationLocals(node, { index: content.index, item: content[node.loop.elementVariable] }) : {};
  }

  private iterationLocals(node: NodeInfo, iteration: { index: number; item: unknown }) {
    return { [node.loop!.elementVariable]: iteration.item, loopCounter: iteration.index };
  }

  private record(live: LiveInstance, entry: Omit<HistoryEntry, 'at'>) {
    // A restored instance re-announces its waits and timers; they are in the history already.
    if (live.replaying && (entry.type === 'waiting' || entry.type === 'node-entered')) return;
    this.pushHistory(live.record, entry);
  }

  private pushHistory(record: ProcessInstance, entry: Omit<HistoryEntry, 'at'>) {
    record.history.push({ at: new Date().toISOString(), ...entry });
  }

  /** Save soon. Events come in bursts; one save covers all of them. */
  private persist(live: LiveInstance) {
    live.dirty = true;
    live.saving ??= this.flush(live)
      .catch((err) => this.log.error(`saving instance ${live.record.id}: ${errorMessage(err)}`))
      .finally(() => (live.saving = undefined));
  }

  private async flush(live: LiveInstance) {
    while (live.dirty) {
      live.dirty = false;
      live.record.engineState = (await live.engine.getState()) as object;
      live.record.waits = [...live.waits.values()];
      await this.instances.save(live.record);
      this.events.next({ type: 'instance', instanceId: live.record.id });
    }
  }
}
