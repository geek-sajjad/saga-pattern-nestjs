import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Subject } from 'rxjs';
import { Repository } from 'typeorm';
import { parseBpmn } from './bpmn-parser';
import { Deployment, HistoryEntry, ProcessInstance, Subscription, Token } from './entities';
import { durationMs, evaluate } from './expressions';
import { BpmnError, HandlerRegistry } from './handlers';
import { ACTIVITY_TYPES, FlowNode, ProcessDefinition } from './model';

export type EngineEvent = { type: 'instance'; instanceId: string } | { type: 'deployed'; key: string; version: number };

export interface MigrationResult {
  instanceId: string;
  ok: boolean;
  problems: string[];
}

const shortId = () => randomUUID().slice(0, 8);
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pick = (vars: Record<string, any>, names: string[]) => Object.fromEntries(names.filter((n) => n in vars).map((n) => [n, vars[n]]));

/** Wait states whose subscriptions can be rebuilt from the diagram alone, so migration may even change their type. */
const EVENT_WAIT_TYPES = ['intermediateCatchEvent', 'receiveTask', 'eventBasedGateway'];

/**
 * A minimal BPMN 2.0 process engine.
 *
 * The whole engine is one idea: **token passing**. A process instance holds
 * one or more tokens; each token sits on a node of the graph. The engine
 * repeatedly picks a READY token and executes its node's behaviour:
 *
 *   start event / task       → move along the outgoing flow
 *   service task             → run the handler code, then move on
 *   user task, receive task,
 *   timer / message event    → park the token (WAITING) until a person / the clock / a message wakes it
 *   event-based gateway      → park the token on SEVERAL events at once; the first one to happen wins
 *   exclusive gateway (XOR)  → evaluate conditions, move along the first true flow
 *   parallel gateway (AND)   → fork: one token per outgoing flow
 *                              join: wait until a token arrived on every incoming flow
 *   sub-process              → park the token on the sub-process and start a child token inside it
 *   call activity            → park the token and start a separate instance of another process
 *   multi-instance activity  → park a "body" token and start one child token per list item
 *   end event                → consume the token; no tokens left = scope (or instance) completed
 *
 * After every step the instance is saved, so a crash loses nothing.
 */
@Injectable()
export class BpmnEngine implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('bpmn-engine');
  private readonly definitions = new Map<string, ProcessDefinition>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Work that must only start once an instance is saved: running a child
   * instance, cancelling one, telling a parent that its child ended. It lives
   * in memory, so a crash can lose it; resumeAfterRestart() reconciles that.
   */
  private readonly afterSave = new Map<string, (() => void)[]>();
  private timerLoop?: NodeJS.Timeout;
  private firingTimers = false;
  /** Observability only (the UI listens to it); the engine never depends on it. */
  readonly events = new Subject<EngineEvent>();

  constructor(
    @InjectRepository(Deployment) private readonly deployments: Repository<Deployment>,
    @InjectRepository(ProcessInstance) private readonly instances: Repository<ProcessInstance>,
    private readonly handlers: HandlerRegistry,
  ) {}

  async onApplicationBootstrap() {
    await this.resumeAfterRestart();
    // The "job executor": real engines poll a jobs table for due timers and async work.
    this.timerLoop = setInterval(() => this.fireDueTimers().catch((e) => this.log.error(e)), 1000);
  }

  onModuleDestroy() {
    clearInterval(this.timerLoop);
  }

  // ───────────────────────────── deployment & versions ─────────────────────────────

  /** Validate and store a BPMN file. XML that is already deployed (as ANY version) creates no new version. */
  async deploy(xml: string): Promise<Deployment> {
    const parsed = parseBpmn(xml); // throws BpmnValidationError with a list of problems
    const same = await this.deployments.findOneBy({ key: parsed.key, xml });
    if (same) return same;

    const latest = await this.latestDeployment(parsed.key);
    const deployment = await this.deployments.save(
      this.deployments.create({ key: parsed.key, name: parsed.name, version: (latest?.version ?? 0) + 1, versionTag: parsed.versionTag ?? null, xml }),
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

  async definition(key: string, version: number): Promise<ProcessDefinition> {
    const cacheKey = `${key}@${version}`;
    let def = this.definitions.get(cacheKey);
    if (!def) {
      def = parseBpmn((await this.getDeployment(key, version)).xml, version);
      this.definitions.set(cacheKey, def);
    }
    return def;
  }

  /** What changed between two versions: the first question before migrating instances. */
  async diff(key: string, from: number, to: number) {
    const [a, b] = [await this.definition(key, from), await this.definition(key, to)];
    const describe = (n: FlowNode) => ({ id: n.id, type: n.type, name: n.name });
    const differs = (x: FlowNode, y: FlowNode) => x.type !== y.type || x.name !== y.name || x.parentId !== y.parentId || x.handler !== y.handler || !!x.loop !== !!y.loop;
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
   * Returns right away; execution continues in the background.
   */
  async start(key: string, variables: Record<string, unknown> = {}, pin: { version?: number; versionTag?: string } = {}): Promise<ProcessInstance> {
    const deployment = pin.versionTag ? await this.getDeploymentByTag(key, pin.versionTag) : await this.getDeployment(key, pin.version);
    const instance = this.newInstance(await this.definition(key, deployment.version), variables);
    await this.save(instance);
    void this.run(instance.id);
    return instance;
  }

  /** A person finished a user task: merge the form data and move the token on. */
  async completeUserTask(instanceId: string, tokenId: string, data: Record<string, unknown> = {}) {
    await this.mutate(instanceId, (instance, def) => {
      const token = this.findToken(instance, tokenId);
      const node = def.nodes[token.nodeId];
      if (node.type !== 'userTask' || token.state !== 'WAITING' || token.loop) throw new ConflictException(`token ${tokenId} is not waiting at a user task`);
      this.writeVariables(instance, token, data);
      this.completeActivity(instance, def, node, token, `completed by a user with ${JSON.stringify(data)}`);
    });
  }

  /**
   * An external system tells the engine something happened ("vessel arrived").
   * The engine delivers it to every instance with a matching subscription:
   * same message name and, if the subscription has one, the same correlation key.
   * (Camunda 7: RuntimeService.createMessageCorrelation; Zeebe: PublishMessage.)
   * Unlike Zeebe we don't buffer: a message nobody waits for is dropped.
   */
  async correlateMessage(name: string, correlationKey?: string, variables: Record<string, unknown> = {}) {
    const matches = (s: Subscription) =>
      s.kind === 'message' && s.messageName === name && (correlationKey === undefined || s.correlationKey === undefined || s.correlationKey === String(correlationKey));
    const correlated: string[] = [];
    for (const candidate of await this.instances.findBy({ status: 'RUNNING' })) {
      if (!candidate.tokens.some((t) => t.state === 'WAITING' && t.subscriptions?.some(matches))) continue;
      await this.mutate(candidate.id, (instance, def) => {
        const token = instance.tokens.find((t) => t.state === 'WAITING' && t.subscriptions?.some(matches));
        if (!token) return; // someone else got there first
        this.fire(instance, def, token, token.subscriptions!.find(matches)!, variables);
        correlated.push(instance.id);
      }).catch((e) => this.log.warn(`message ${name} → ${candidate.id}: ${errorMessage(e)}`));
    }
    return { name, correlationKey, correlated };
  }

  /** An operator fixed the cause of an incident (e.g. restarted a service): try the node again. */
  async retryIncident(instanceId: string, tokenId: string) {
    await this.mutate(instanceId, (instance) => {
      const token = this.findToken(instance, tokenId);
      if (token.state !== 'INCIDENT') throw new ConflictException(`token ${tokenId} has no incident`);
      this.record(instance, { type: 'incident-retried', nodeId: token.nodeId, tokenId, message: 'retrying after incident' });
      token.state = 'READY';
      delete token.incident;
    });
  }

  /** Operators can fix data before a retry (e.g. correct a wrong address). Replaces the variables wholesale. */
  async setVariables(instanceId: string, variables: Record<string, unknown>) {
    await this.mutate(instanceId, (instance) => {
      instance.variables = variables;
      this.record(instance, { type: 'variables-changed', message: 'variables edited by an operator' });
    });
  }

  /** Stop an instance and every instance it called. Nothing is compensated. */
  async cancel(instanceId: string, reason = 'cancelled by an operator') {
    await this.mutate(instanceId, (instance) => {
      this.removeTokens(instance, [...instance.tokens]);
      instance.status = 'CANCELLED';
      this.record(instance, { type: 'instance-cancelled', message: reason });
      this.notifyParent(instance);
    });
  }

  listInstances() {
    return this.instances.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  children(instanceId: string) {
    return this.instances.find({ where: { parentInstanceId: instanceId }, order: { createdAt: 'ASC' } });
  }

  async getInstance(id: string): Promise<ProcessInstance> {
    const instance = await this.instances.findOneBy({ id });
    if (!instance) throw new NotFoundException(`instance ${id} not found`);
    return instance;
  }

  // ───────────────────────────── migration ─────────────────────────────

  /**
   * Move a RUNNING instance to another version of its process. Each token
   * keeps its place: it moves to the node with the same id (or the id given
   * in `mapping`) in the target version. Timers and messages are re-subscribed
   * against the new diagram; a timer that exists in both keeps its due time.
   * (Camunda 7: the migration API; Camunda 8: Operate's "migrate".)
   */
  async migrate(instanceId: string, targetVersion: number, mapping: Record<string, string> = {}, dryRun = false): Promise<MigrationResult> {
    const result = await this.withLock(instanceId, async () => {
      const instance = await this.getInstance(instanceId);
      if (instance.status !== 'RUNNING') return { instanceId, ok: false, problems: [`instance is ${instance.status}`] };
      const source = await this.definition(instance.definitionKey, instance.definitionVersion);
      const target = await this.definition(instance.definitionKey, targetVersion);
      if (source.version === target.version) return { instanceId, ok: false, problems: [`instance already runs on v${targetVersion}`] };

      const { problems, apply } = this.planMigration(instance, source, target, mapping);
      if (problems.length || dryRun) return { instanceId, ok: !problems.length, problems };

      apply();
      instance.definitionVersion = target.version;
      const mapped = Object.entries(mapping).map(([a, b]) => `${a}→${b}`).join(', ');
      this.record(instance, { type: 'migrated', message: `migrated v${source.version} → v${target.version}${target.versionTag ? ` (${target.versionTag})` : ''}${mapped ? `, mapping ${mapped}` : ''}` });
      await this.save(instance);
      return { instanceId, ok: true, problems: [] };
    });
    if (result.ok && !dryRun) void this.run(instanceId);
    return result;
  }

  /** Migrate every running instance of one version. Each instance succeeds or fails on its own. */
  async migrateAll(key: string, fromVersion: number, toVersion: number, mapping: Record<string, string> = {}, dryRun = false) {
    const running = await this.instances.findBy({ definitionKey: key, definitionVersion: fromVersion, status: 'RUNNING' });
    const results: MigrationResult[] = [];
    for (const instance of running) results.push(await this.migrate(instance.id, toVersion, mapping, dryRun));
    return { key, fromVersion, toVersion, dryRun, migrated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  /** Check every token against the target version first; change nothing unless ALL of them fit. */
  private planMigration(instance: ProcessInstance, source: ProcessDefinition, target: ProcessDefinition, mapping: Record<string, string>) {
    const problems: string[] = [];
    const changes: (() => void)[] = [];
    const to = (id: string) => mapping[id] ?? id;
    const v = `v${target.version}`;

    for (const token of instance.tokens) {
      const from = source.nodes[token.nodeId];
      const node = target.nodes[to(token.nodeId)];
      const where = `token ${token.id} at "${from?.name ?? token.nodeId}"`;
      if (!node) {
        problems.push(`${where}: ${v} has no node "${to(token.nodeId)}"; map it to one that exists`);
        continue;
      }
      if (token.state === 'EXECUTING') problems.push(`${where}: a handler is running right now; try again in a moment`);
      const waiting = token.state === 'WAITING';
      if (waiting && from.type !== node.type && !(EVENT_WAIT_TYPES.includes(from.type) && EVENT_WAIT_TYPES.includes(node.type))) {
        problems.push(`${where}: it waits in a ${from.type}, but "${node.id}" is a ${node.type} in ${v}; only waiting events and receive tasks may change type`);
      }
      if ((token.loop || token.loopIndex !== undefined) && !node.loop) problems.push(`${where}: a multi-instance loop is running, but "${node.id}" is not multi-instance in ${v}`);
      if (token.loopIndex === undefined) {
        const scope = token.scopeId ? instance.tokens.find((t) => t.id === token.scopeId) : undefined;
        if (node.parentId !== (scope ? to(scope.nodeId) : undefined)) problems.push(`${where}: "${node.id}" sits in a different sub-process in ${v}`);
      }
      if (waiting && node.type === 'parallelGateway' && token.viaFlow && !node.incoming.includes(token.viaFlow)) {
        problems.push(`${where}: it waits at a join for flow ${token.viaFlow}, which does not enter "${node.id}" in ${v}`);
      }

      let subscriptions = token.subscriptions;
      if (waiting && node.type !== 'parallelGateway') {
        try {
          subscriptions = this.subscriptionTargets(target, node, token).map((event) => {
            const kept = token.subscriptions?.find((s) => to(s.eventId) === event.id && s.kind === (event.eventKind === 'timer' ? 'timer' : 'message'));
            return kept ? { ...kept, eventId: event.id, interrupting: event.type === 'boundaryEvent' ? event.interrupting : undefined } : this.subscribe(instance, token, event);
          });
        } catch (err) {
          problems.push(`${where}: cannot subscribe to the events of "${node.id}": ${errorMessage(err)}`);
        }
      }
      changes.push(() => {
        token.nodeId = node.id;
        token.subscriptions = subscriptions?.length ? subscriptions : undefined;
      });
    }

    const apply = () => {
      changes.forEach((change) => change());
      // Keep the compensation log pointing at nodes that exist in the new version.
      for (const done of instance.completed) if (target.nodes[to(done.nodeId)]) done.nodeId = to(done.nodeId);
    };
    return { problems, apply };
  }

  // ───────────────────────────── the token loop ─────────────────────────────

  /** Load the instance and execute READY tokens until every token waits or is gone. */
  private run(instanceId: string): Promise<void> {
    return this.withLock(instanceId, async () => {
      const instance = await this.getInstance(instanceId);
      const def = await this.definition(instance.definitionKey, instance.definitionVersion);

      for (let steps = 0; instance.status === 'RUNNING'; steps++) {
        const token = instance.tokens.find((t) => t.state === 'READY');
        if (!token) break; // everything is waiting (user task, timer, message, join, incident) or done
        if (steps > 1000) {
          this.incident(instance, token, 'more than 1000 steps without a wait state; is there an endless loop?');
        } else {
          await this.execute(instance, def, token);
        }
        await this.save(instance);
      }
    }).catch((err) => this.log.error(`instance ${instanceId}: ${errorMessage(err)}`));
  }

  /** The behaviour of each BPMN element type. */
  private async execute(instance: ProcessInstance, def: ProcessDefinition, token: Token): Promise<void> {
    const node = def.nodes[token.nodeId];

    // A multi-instance activity: the arriving token becomes the loop body;
    // its iterations (loopIndex set) run the activity itself.
    if (node.loop && token.loopIndex === undefined) return this.startLoop(instance, def, node, token);

    switch (node.type) {
      case 'startEvent':
      case 'boundaryEvent': // a caught error / fired timer or message: just continue along its flow
        this.completeNode(instance, node, token);
        return this.leave(instance, def, token, node.outgoing);

      case 'task': // a task with no type does nothing; it's documentation
        return this.completeActivity(instance, def, node, token);

      case 'serviceTask':
        return this.executeServiceTask(instance, def, node, token);

      case 'userTask':
        this.park(instance, def, node, token, `waiting for a person to complete "${node.name}"`);
        return;

      case 'receiveTask':
      case 'intermediateCatchEvent':
        this.park(instance, def, node, token, node.eventKind === 'timer' ? `timer set for ${node.timerDuration}` : `waiting for message "${node.message!.name}"`);
        return;

      case 'eventBasedGateway': {
        const names = node.outgoing.map((f) => `"${def.nodes[def.flows[f].targetRef].name ?? def.flows[f].targetRef}"`).join(' or ');
        this.park(instance, def, node, token, `racing ${names}: the first to happen wins`);
        return;
      }

      case 'subProcess':
        // The token stays on the sub-process (so its boundary events can fire) and a child token starts inside.
        if (this.park(instance, def, node, token, `entered sub-process "${node.name ?? node.id}"`)) {
          instance.tokens.push({ id: shortId(), nodeId: node.startNodeId!, state: 'READY', scopeId: token.id });
        }
        return;

      case 'callActivity':
        return this.startCallActivity(instance, def, node, token);

      case 'intermediateThrowEvent':
        if (node.eventKind === 'compensate' && !(await this.compensate(instance, def, node, token))) return;
        this.completeNode(instance, node, token);
        return this.leave(instance, def, token, node.outgoing);

      case 'exclusiveGateway': {
        let chosen: string | undefined;
        try {
          chosen = this.chooseExclusiveFlow(def, node, this.scopeVariables(instance, token));
        } catch (err) {
          return this.incident(instance, token, `condition failed: ${errorMessage(err)}`);
        }
        if (!chosen) return this.incident(instance, token, `no condition of "${node.name ?? node.id}" is true and there is no default flow`);
        this.completeNode(instance, node, token);
        return this.leave(instance, def, token, [chosen]);
      }

      case 'parallelGateway':
        return this.executeParallelGateway(instance, def, node, token);

      case 'endEvent':
        return this.executeEndEvent(instance, def, node, token);
    }
  }

  private async executeServiceTask(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token) {
    const handler = this.handlers.get(node.handler!);
    if (!handler) return this.incident(instance, token, `no handler registered for "${node.handler}"`);

    // Persist EXECUTING before calling out. If the engine dies during the call,
    // resumeAfterRestart() runs the handler again: at-least-once, so handlers must be idempotent.
    token.state = 'EXECUTING';
    this.record(instance, { type: 'node-entered', nodeId: node.id, tokenId: token.id, message: `calling handler "${node.handler}"` });
    await this.save(instance);

    try {
      const result = await handler({ instanceId: instance.id, nodeId: node.id, variables: structuredClone(this.scopeVariables(instance, token)) });
      this.writeVariables(instance, token, result ?? undefined);
      this.completeActivity(instance, def, node, token);
    } catch (err) {
      if (err instanceof BpmnError) return this.throwError(instance, def, token, err.code, err.message);
      // Not modelled in the diagram: a technical problem for a human.
      this.incident(instance, token, errorMessage(err));
    }
  }

  private chooseExclusiveFlow(def: ProcessDefinition, node: FlowNode, variables: Record<string, unknown>): string | undefined {
    for (const flowId of node.outgoing) {
      if (flowId === node.defaultFlow) continue;
      const { condition } = def.flows[flowId];
      if (!condition || evaluate(condition, variables)) return flowId; // first match wins, in diagram order
    }
    return node.defaultFlow;
  }

  private executeParallelGateway(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token) {
    let continuing = token;

    if (node.incoming.length > 1) {
      // JOIN: park this token and check whether every incoming flow has delivered one (in the same scope).
      token.state = 'WAITING';
      const parked = instance.tokens.filter((t) => t.nodeId === node.id && t.state === 'WAITING' && t.scopeId === token.scopeId);
      const arrivals = node.incoming.map((flowId) => parked.find((t) => t.viaFlow === flowId));
      const arrived = arrivals.filter(Boolean).length;
      if (arrived < node.incoming.length) {
        this.record(instance, { type: 'waiting', nodeId: node.id, tokenId: token.id, message: `join: ${arrived}/${node.incoming.length} branches arrived` });
        return;
      }
      // All branches are here: merge their tokens into one.
      const consumed = arrivals as Token[];
      instance.tokens = instance.tokens.filter((t) => !consumed.includes(t));
      continuing = consumed[0];
      instance.tokens.push(continuing);
    }

    // FORK (or a plain pass-through when there is a single outgoing flow).
    this.completeNode(instance, node, continuing);
    this.leave(instance, def, continuing, node.outgoing);
  }

  private executeEndEvent(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token) {
    this.completeNode(instance, node, token);
    if (node.eventKind === 'error') {
      return this.throwError(instance, def, token, node.errorCode!, `end event "${node.name ?? node.id}" threw ${node.errorCode}`);
    }
    instance.tokens = instance.tokens.filter((t) => t !== token);
    if (node.eventKind === 'terminate') {
      // Terminate ends its own scope: the whole instance, or just the sub-process it sits in.
      const doomed = token.scopeId ? this.descendants(instance, token.scopeId) : [...instance.tokens];
      if (doomed.length) {
        this.removeTokens(instance, doomed);
        this.record(instance, { type: 'instance-terminated', nodeId: node.id, message: `terminate end event removed ${doomed.length} other token(s)${token.scopeId ? ' in its sub-process' : ''}` });
      }
    }
    this.finishScopeIfEmpty(instance, def, token.scopeId, node);
  }

  /** The last token of a scope is gone: the sub-process completes, or the whole instance does. */
  private finishScopeIfEmpty(instance: ProcessInstance, def: ProcessDefinition, scopeId: string | undefined, endNode: FlowNode) {
    if (!scopeId) {
      if (instance.tokens.length) return;
      instance.status = 'COMPLETED';
      this.record(instance, { type: 'instance-completed', nodeId: endNode.id, message: `completed at "${endNode.name ?? endNode.id}"` });
      this.notifyParent(instance);
      return;
    }
    if (instance.tokens.some((t) => t.scopeId === scopeId)) return;
    const scopeToken = instance.tokens.find((t) => t.id === scopeId);
    if (scopeToken) this.completeActivity(instance, def, def.nodes[scopeToken.nodeId], scopeToken, `sub-process finished at "${endNode.name ?? endNode.id}"`);
  }

  // ───────────────────────────── waiting: timers, messages, event-based gateways ─────────────────────────────

  /**
   * Park a token and subscribe to everything that may wake it: its own event
   * (a timer or message catch event, a receive task, the events after an
   * event-based gateway) and the timer/message boundary events of its activity.
   */
  private park(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token, message: string): boolean {
    try {
      const subscriptions = this.subscriptionTargets(def, node, token).map((event) => this.subscribe(instance, token, event));
      token.subscriptions = subscriptions.length ? subscriptions : undefined;
    } catch (err) {
      this.incident(instance, token, errorMessage(err));
      return false;
    }
    token.state = 'WAITING';
    this.record(instance, { type: 'waiting', nodeId: node.id, tokenId: token.id, message });
    return true;
  }

  /** Which events a token waiting on `node` listens for. Shared by execution and migration. */
  private subscriptionTargets(def: ProcessDefinition, node: FlowNode, token: Token): FlowNode[] {
    const own =
      token.loop ? [] // a loop body only listens to its boundary events
      : node.type === 'eventBasedGateway' ? node.outgoing.map((f) => def.nodes[def.flows[f].targetRef])
      : node.type === 'intermediateCatchEvent' || node.type === 'receiveTask' ? [node]
      : [];
    // Boundary events belong to the activity as a whole, so a loop's iterations don't subscribe; the body does.
    const boundaries =
      token.loopIndex !== undefined || !ACTIVITY_TYPES.includes(node.type) ? []
      : node.boundaryEvents.map((id) => def.nodes[id]).filter((b) => b.eventKind === 'timer' || b.eventKind === 'message');
    return [...own, ...boundaries];
  }

  private subscribe(instance: ProcessInstance, token: Token, event: FlowNode): Subscription {
    const interrupting = event.type === 'boundaryEvent' ? event.interrupting : undefined;
    if (event.eventKind === 'timer') return { kind: 'timer', eventId: event.id, dueAt: Date.now() + durationMs(event.timerDuration!), interrupting };
    const { name, correlationKey } = event.message!;
    // The key is evaluated NOW, against this token's variables: "wait for VesselArrived for shipment IMP-123".
    const key = correlationKey ? evaluate(correlationKey, this.scopeVariables(instance, token)) : undefined;
    return { kind: 'message', eventId: event.id, messageName: name, correlationKey: key == null ? undefined : String(key), interrupting };
  }

  /** A timer is due or a message arrived for a waiting token. */
  private fire(instance: ProcessInstance, def: ProcessDefinition, token: Token, sub: Subscription, payload?: Record<string, unknown>) {
    const event = def.nodes[sub.eventId];
    const what = sub.kind === 'timer' ? `timer ${event.timerDuration} fired` : `message "${sub.messageName}" received`;
    this.record(instance, { type: sub.kind === 'timer' ? 'timer-fired' : 'message-received', nodeId: event.id, tokenId: token.id, message: what });
    if (payload && Object.keys(payload).length) this.writeVariables(instance, token, payload);

    // 1. The token waits AT this event (catch event, receive task): it simply moves on.
    if (event.id === token.nodeId) return this.completeActivity(instance, def, event, token, what);

    // 2. The token waits at an event-based gateway: this event won the race, the others are dropped.
    const here = def.nodes[token.nodeId];
    if (here.type === 'eventBasedGateway') {
      const flowId = here.outgoing.find((f) => def.flows[f].targetRef === event.id)!;
      this.completeNode(instance, here, token, `"${event.name ?? event.id}" happened first`);
      this.record(instance, { type: 'flow-taken', flowId, tokenId: token.id, message: `→ ${event.name ?? event.id}` });
      token.nodeId = event.id;
      token.viaFlow = flowId;
      this.completeNode(instance, event, token, what);
      return this.leave(instance, def, token, event.outgoing);
    }

    // 3. A boundary event of the activity the token waits in.
    if (sub.interrupting) {
      this.interrupt(instance, token); // cancels the activity, everything inside it, and any called instance
      token.nodeId = event.id;
      token.state = 'READY';
      return;
    }
    // Non-interrupting: the activity keeps waiting and a NEW token runs the boundary path alongside it.
    token.subscriptions = token.subscriptions?.filter((s) => s !== sub);
    if (!token.subscriptions?.length) delete token.subscriptions;
    instance.tokens.push({ id: shortId(), nodeId: event.id, state: 'READY', scopeId: token.scopeId });
  }

  // ───────────────────────────── multi-instance ─────────────────────────────

  private startLoop(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token) {
    const loop = node.loop!;
    let items: unknown;
    try {
      items = evaluate(loop.collection, this.scopeVariables(instance, token));
    } catch (err) {
      return this.incident(instance, token, `multi-instance collection failed: ${errorMessage(err)}`);
    }
    if (!Array.isArray(items)) return this.incident(instance, token, `multi-instance collection ${loop.collection} is not a list`);

    token.loop = { items, started: 0, finished: 0, results: [] };
    const how = loop.sequential ? 'one after another' : 'in parallel';
    if (!this.park(instance, def, node, token, `multi-instance: ${items.length} iteration(s) of "${node.name ?? node.id}", ${how}`)) {
      delete token.loop;
      return;
    }
    this.record(instance, { type: 'loop-started', nodeId: node.id, tokenId: token.id, message: `${items.length} × ${loop.elementVariable}, ${how}` });
    if (!items.length) return this.finishLoop(instance, def, node, token);
    for (let i = 0; i < (loop.sequential ? 1 : items.length); i++) this.startIteration(instance, node, token);
  }

  private startIteration(instance: ProcessInstance, node: FlowNode, body: Token) {
    const i = body.loop!.started++;
    instance.tokens.push({
      id: shortId(),
      nodeId: node.id,
      state: 'READY',
      scopeId: body.id,
      loopIndex: i,
      locals: { [node.loop!.elementVariable]: body.loop!.items[i], loopCounter: i },
    });
  }

  private finishIteration(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token, result: unknown) {
    const body = this.parentToken(instance, token)!;
    instance.tokens = instance.tokens.filter((t) => t !== token);
    body.loop!.results[token.loopIndex!] = result;
    body.loop!.finished++;
    if (node.loop!.sequential && body.loop!.started < body.loop!.items.length) return this.startIteration(instance, node, body);
    if (body.loop!.finished === body.loop!.items.length) this.finishLoop(instance, def, node, body);
  }

  private finishLoop(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, body: Token) {
    const { outputCollection } = node.loop!;
    if (outputCollection) this.writeVariables(instance, body, { [outputCollection]: body.loop!.results });
    this.completeNode(instance, node, body, `all ${body.loop!.items.length} iterations done${outputCollection ? `, collected into "${outputCollection}"` : ''}`);
    this.leave(instance, def, body, node.outgoing);
  }

  // ───────────────────────────── call activities ─────────────────────────────

  /**
   * Start a separate instance of another process and wait for it. The child
   * has its own tokens, variables, history and VERSION: which version is
   * decided here, by the call activity's binding.
   */
  private async startCallActivity(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token) {
    const vars = this.scopeVariables(instance, token);
    let called: ProcessDefinition;
    try {
      const ref = node.calledVersion?.startsWith('${') ? String(evaluate(node.calledVersion, vars)) : node.calledVersion;
      const deployment =
        node.binding === 'versionTag' ? await this.getDeploymentByTag(node.calledElement!, ref!)
        : await this.getDeployment(node.calledElement!, node.binding === 'version' ? Number(ref) : undefined);
      called = await this.definition(deployment.key, deployment.version);
    } catch (err) {
      return this.incident(instance, token, `cannot call "${node.calledElement}": ${errorMessage(err)}`);
    }

    const child = this.newInstance(called, structuredClone(node.inputs ? pick(vars, node.inputs) : vars), { instanceId: instance.id, tokenId: token.id });
    const label = `${called.key} v${called.version}${called.versionTag ? ` (${called.versionTag})` : ''}`;
    if (!this.park(instance, def, node, token, `waiting for called instance ${child.id.slice(0, 8)} to finish`)) return;
    token.childInstanceId = child.id;
    this.record(instance, { type: 'called', nodeId: node.id, tokenId: token.id, message: `started ${label} as instance ${child.id.slice(0, 8)} (binding: ${node.binding}${node.calledVersion ? ` ${node.calledVersion}` : ''})` });
    await this.save(child);
    this.later(instance.id, () => void this.run(child.id));
  }

  /** A called instance completed, was terminated by an error, or was cancelled: continue the parent. */
  private async onChildEnded(parentId: string, tokenId: string, childId: string) {
    const child = await this.getInstance(childId);
    if (child.status === 'RUNNING') return;
    await this.mutate(parentId, (parent, def) => {
      const token = parent.tokens.find((t) => t.id === tokenId && t.childInstanceId === childId);
      if (!token || token.state !== 'WAITING') return; // delivered before (at-least-once), or the call was interrupted
      const node = def.nodes[token.nodeId];
      delete token.childInstanceId;
      if (child.status === 'COMPLETED') {
        this.writeVariables(parent, token, structuredClone(node.outputs ? pick(child.variables, node.outputs) : child.variables));
        return this.completeActivity(parent, def, node, token, `called instance ${childId.slice(0, 8)} completed`);
      }
      if (child.status === 'TERMINATED' && child.endError) {
        return this.throwError(parent, def, token, child.endError.code, `called process: ${child.endError.message}`);
      }
      this.incident(parent, token, `called instance ${childId.slice(0, 8)} was cancelled; retry starts a new one`);
    });
  }

  private notifyParent(instance: ProcessInstance) {
    const { parentInstanceId, parentTokenId } = instance;
    if (!parentInstanceId || !parentTokenId) return;
    this.later(instance.id, () => void this.onChildEnded(parentInstanceId, parentTokenId, instance.id).catch((e) => this.log.warn(`notify parent ${parentInstanceId}: ${errorMessage(e)}`)));
  }

  // ───────────────────────────── errors and compensation ─────────────────────────────

  /**
   * A BPMN error travels OUTWARDS until something catches it: the activity's
   * own error boundary, then the enclosing sub-process, then its parent… and
   * finally the call activity in the calling process. The catching activity
   * is interrupted: every token inside it is removed.
   */
  private throwError(instance: ProcessInstance, def: ProcessDefinition, token: Token, code: string, message: string) {
    for (let t: Token | undefined = token; t; ) {
      // An iteration of a loop throws on behalf of the whole loop: boundary events sit on the body.
      const host = t.loopIndex !== undefined ? this.parentToken(instance, t)! : t;
      const activity = def.nodes[host.nodeId];
      const boundary = activity.boundaryEvents
        .map((id) => def.nodes[id])
        .find((b) => b.eventKind === 'error' && (!b.errorCode || b.errorCode === code));
      if (boundary) {
        instance.variables.lastError = { code, message, nodeId: token.nodeId };
        this.record(instance, { type: 'error-caught', nodeId: boundary.id, tokenId: host.id, message: `"${activity.name ?? activity.id}" caught ${code}: ${message}` });
        this.interrupt(instance, host);
        host.nodeId = boundary.id;
        host.state = 'READY';
        delete host.incident;
        return;
      }
      t = this.parentToken(instance, host);
    }

    if (instance.parentInstanceId) {
      // Nobody in this instance catches it: end here and let the calling process deal with it.
      this.record(instance, { type: 'error-propagated', nodeId: token.nodeId, tokenId: token.id, message: `nothing here catches ${code}; ending and handing it to the calling process` });
      this.removeTokens(instance, [...instance.tokens]);
      instance.status = 'TERMINATED';
      instance.endError = { code, message };
      this.notifyParent(instance);
      return;
    }
    // Not modelled anywhere: a technical problem for a human.
    this.incident(instance, token, `uncaught BPMN error ${code}: ${message}`);
  }

  /**
   * Compensation = BPMN's built-in saga. Walk the COMPLETED activities
   * backwards and run the compensation handler of each one that has one.
   * Activities that never completed (e.g. the one that just failed) are not
   * compensated: there is nothing to undo.
   */
  private async compensate(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token): Promise<boolean> {
    const todo = [...instance.completed].reverse().filter((c) => !c.compensated && def.nodes[c.nodeId]?.compensatedBy);
    this.record(instance, { type: 'compensation-started', nodeId: node.id, tokenId: token.id, message: `undoing ${todo.length} completed activit${todo.length === 1 ? 'y' : 'ies'} in reverse order` });

    for (const done of todo) {
      const undo = def.nodes[def.nodes[done.nodeId].compensatedBy!];
      const handler = this.handlers.get(undo.handler ?? '');
      if (!handler) {
        this.incident(instance, token, `compensation task "${undo.name}" has no registered handler "${undo.handler}"`);
        return false;
      }
      try {
        const result = await handler({ instanceId: instance.id, nodeId: undo.id, variables: structuredClone({ ...instance.variables, ...done.locals }) });
        if (result) Object.assign(instance.variables, result);
      } catch (err) {
        // A compensation must eventually succeed: stop here, an operator retries (already-undone steps are skipped).
        this.incident(instance, token, `compensation "${undo.name}" failed: ${errorMessage(err)}`);
        return false;
      }
      done.compensated = true;
      this.record(instance, { type: 'compensated', nodeId: undo.id, message: `"${undo.name}" undid "${def.nodes[done.nodeId].name}"` });
      await this.save(instance);
    }
    return true;
  }

  // ───────────────────────────── token helpers ─────────────────────────────

  /**
   * Move a token along the given flows. Several flows out of an activity mean
   * an implicit parallel split: the token is cloned for every extra flow.
   */
  private leave(instance: ProcessInstance, def: ProcessDefinition, token: Token, flowIds: string[]) {
    flowIds.forEach((flowId, i) => {
      const t: Token = i === 0 ? token : { id: shortId(), nodeId: token.nodeId, state: 'READY', scopeId: token.scopeId };
      if (i > 0) instance.tokens.push(t);
      const flow = def.flows[flowId];
      t.nodeId = flow.targetRef;
      t.viaFlow = flow.id;
      t.state = 'READY';
      delete t.subscriptions;
      delete t.loop;
      delete t.childInstanceId;
      delete t.dueAt;
      this.record(instance, { type: 'flow-taken', flowId, tokenId: t.id, message: `→ ${def.nodes[flow.targetRef].name ?? flow.targetRef}${flow.name ? ` (${flow.name})` : ''}` });
    });
  }

  /** An activity is done: an iteration reports back to its loop, anything else moves on. */
  private completeActivity(instance: ProcessInstance, def: ProcessDefinition, node: FlowNode, token: Token, message?: string) {
    if (token.loopIndex === undefined) {
      this.completeNode(instance, node, token, message);
      return this.leave(instance, def, token, node.outgoing);
    }
    const { elementVariable, outputElement } = node.loop!;
    let result: unknown;
    try {
      const { [elementVariable]: _item, loopCounter: _i, ...produced } = token.locals ?? {};
      result = outputElement ? evaluate(outputElement, this.scopeVariables(instance, token)) : produced;
    } catch (err) {
      return this.incident(instance, token, `outputElement ${outputElement} failed: ${errorMessage(err)}`);
    }
    this.completeNode(instance, node, token, message);
    this.finishIteration(instance, def, node, token, result);
  }

  private completeNode(instance: ProcessInstance, node: FlowNode, token: Token, message?: string) {
    // The loop body isn't recorded: each iteration already was (and is compensated on its own).
    if (ACTIVITY_TYPES.includes(node.type) && !token.loop) {
      const locals = this.localVariables(instance, token);
      instance.completed.push({ nodeId: node.id, at: new Date().toISOString(), ...(locals ? { locals } : {}) });
    }
    this.record(instance, { type: 'node-completed', nodeId: node.id, tokenId: token.id, message: message ?? `${node.type} "${node.name ?? node.id}" done` });
  }

  /** Cancel an activity in place: drop everything running inside it and stop listening to its events. */
  private interrupt(instance: ProcessInstance, host: Token) {
    this.removeTokens(instance, this.descendants(instance, host.id));
    if (host.childInstanceId) this.cancelChildLater(instance, host.childInstanceId);
    delete host.subscriptions;
    delete host.loop;
    delete host.childInstanceId;
  }

  private removeTokens(instance: ProcessInstance, doomed: Token[]) {
    for (const t of doomed) if (t.childInstanceId) this.cancelChildLater(instance, t.childInstanceId);
    instance.tokens = instance.tokens.filter((t) => !doomed.includes(t));
  }

  private cancelChildLater(instance: ProcessInstance, childId: string) {
    this.later(instance.id, () => void this.cancel(childId, `cancelled because the calling instance ${instance.id.slice(0, 8)} no longer needs it`).catch(() => undefined));
  }

  /** Every token inside the scope of `scopeId`, at any depth. */
  private descendants(instance: ProcessInstance, scopeId: string): Token[] {
    const found: Token[] = [];
    const queue = [scopeId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const t of instance.tokens.filter((x) => x.scopeId === id)) {
        found.push(t);
        queue.push(t.id);
      }
    }
    return found;
  }

  private parentToken(instance: ProcessInstance, token: Token): Token | undefined {
    return token.scopeId ? instance.tokens.find((t) => t.id === token.scopeId) : undefined;
  }

  /** The token and its enclosing scopes, innermost first. */
  private scopeChain(instance: ProcessInstance, token: Token): Token[] {
    const chain: Token[] = [];
    for (let t: Token | undefined = token; t; t = this.parentToken(instance, t)) chain.push(t);
    return chain;
  }

  /** What code running at this token sees: process variables, overlaid with the locals of every enclosing loop iteration. */
  private scopeVariables(instance: ProcessInstance, token: Token): Record<string, any> {
    return Object.assign({}, instance.variables, this.localVariables(instance, token));
  }

  private localVariables(instance: ProcessInstance, token: Token): Record<string, any> | undefined {
    const layers = this.scopeChain(instance, token).reverse().map((t) => t.locals).filter(Boolean);
    return layers.length ? Object.assign({}, ...layers) : undefined;
  }

  /** Results land in the nearest loop iteration (so parallel iterations don't overwrite each other), else on the process. */
  private writeVariables(instance: ProcessInstance, token: Token, data: Record<string, unknown> | undefined) {
    if (!data) return;
    const iteration = this.scopeChain(instance, token).find((t) => t.loopIndex !== undefined);
    Object.assign(iteration ? (iteration.locals ??= {}) : instance.variables, data);
  }

  private newInstance(def: ProcessDefinition, variables: Record<string, unknown>, parent?: { instanceId: string; tokenId: string }) {
    const instance = this.instances.create({
      id: randomUUID(),
      definitionKey: def.key,
      definitionVersion: def.version,
      status: 'RUNNING',
      tokens: [{ id: shortId(), nodeId: def.startNodeId, state: 'READY' }],
      variables,
      completed: [],
      history: [],
      parentInstanceId: parent?.instanceId ?? null,
      parentTokenId: parent?.tokenId ?? null,
      endError: null,
    });
    const tag = def.versionTag ? ` (${def.versionTag})` : '';
    this.record(instance, { type: 'instance-started', message: `started ${def.name} v${def.version}${tag}${parent ? `, called by instance ${parent.instanceId.slice(0, 8)}` : ''}` });
    return instance;
  }

  private incident(instance: ProcessInstance, token: Token, message: string) {
    token.state = 'INCIDENT';
    token.incident = message;
    this.record(instance, { type: 'incident', nodeId: token.nodeId, tokenId: token.id, message });
    this.log.warn(`[${instance.id.slice(0, 8)}] incident at ${token.nodeId}: ${message}`);
  }

  private findToken(instance: ProcessInstance, tokenId: string): Token {
    const token = instance.tokens.find((t) => t.id === tokenId);
    if (!token) throw new NotFoundException(`token ${tokenId} not found in instance ${instance.id}`);
    return token;
  }

  private record(instance: ProcessInstance, entry: Omit<HistoryEntry, 'at'>) {
    instance.history.push({ at: new Date().toISOString(), ...entry });
  }

  private later(instanceId: string, fn: () => void) {
    this.afterSave.set(instanceId, [...(this.afterSave.get(instanceId) ?? []), fn]);
  }

  private async save(instance: ProcessInstance) {
    await this.instances.save(instance);
    this.events.next({ type: 'instance', instanceId: instance.id });
    const queued = this.afterSave.get(instance.id);
    this.afterSave.delete(instance.id);
    queued?.forEach((fn) => fn());
  }

  // ───────────────────────────── concurrency, timers, recovery ─────────────────────────────

  /**
   * Only one thing may change an instance at a time (a user completing a task
   * while a timer fires, for example). Real engines use optimistic locking on
   * a version column; a per-instance promise chain is enough for one process.
   */
  private withLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(instanceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(instanceId, next);
    next.finally(() => this.locks.get(instanceId) === next && this.locks.delete(instanceId)).catch(() => undefined);
    return next;
  }

  /** Change an instance under the lock, save, then let the token loop continue in the background. */
  private async mutate(instanceId: string, change: (instance: ProcessInstance, def: ProcessDefinition) => void) {
    const instance = await this.withLock(instanceId, async () => {
      const instance = await this.getInstance(instanceId);
      if (instance.status !== 'RUNNING') throw new ConflictException(`instance ${instanceId} is ${instance.status}`);
      change(instance, await this.definition(instance.definitionKey, instance.definitionVersion));
      await this.save(instance);
      return instance;
    });
    void this.run(instanceId);
    return instance;
  }

  private async fireDueTimers() {
    if (this.firingTimers) return; // the previous tick is still busy
    this.firingTimers = true;
    try {
      await this.fireDueTimersNow();
    } finally {
      this.firingTimers = false;
    }
  }

  private async fireDueTimersNow() {
    const now = Date.now();
    const due = (t: Token) => t.state === 'WAITING' && !!t.subscriptions?.some((s) => s.kind === 'timer' && s.dueAt! <= now);
    const running = await this.instances.findBy({ status: 'RUNNING' });
    for (const instance of running) {
      if (!instance.tokens.some(due)) continue;
      await this.mutate(instance.id, (fresh, def) => {
        for (const token of fresh.tokens.filter(due)) {
          // Fire one timer per token per tick: an interrupting one may already have moved the token.
          const sub = token.subscriptions!.find((s) => s.kind === 'timer' && s.dueAt! <= now)!;
          if (fresh.tokens.includes(token) && token.state === 'WAITING') this.fire(fresh, def, token, sub);
        }
      }).catch((e) => this.log.error(e));
    }
  }

  /** After a crash or restart, pick up every instance that still has work to do, and repair parent/child links. */
  private async resumeAfterRestart() {
    const running = await this.instances.findBy({ status: 'RUNNING' });
    const followUps: (() => Promise<unknown>)[] = [];

    for (const instance of running) {
      let changed = false;
      for (const token of instance.tokens) {
        // Upgrade timers saved by older versions of this engine.
        if (token.dueAt && token.state === 'WAITING' && !token.subscriptions) {
          token.subscriptions = [{ kind: 'timer', eventId: token.nodeId, dueAt: token.dueAt }];
          delete token.dueAt;
          changed = true;
        }
        if (token.state === 'EXECUTING') {
          token.state = 'READY';
          this.record(instance, { type: 'incident-retried', nodeId: token.nodeId, tokenId: token.id, message: 'engine restarted while this handler was running: executing it again (at-least-once)' });
          changed = true;
        }
        // The child finished, but we crashed before hearing about it.
        if (token.childInstanceId && token.state === 'WAITING') {
          const child = await this.instances.findOneBy({ id: token.childInstanceId });
          if (child && child.status !== 'RUNNING') followUps.push(() => this.onChildEnded(instance.id, token.id, child.id));
        }
      }
      // A child whose parent no longer waits for it (we crashed between creating it and saving the parent).
      if (instance.parentInstanceId) {
        const parent = await this.instances.findOneBy({ id: instance.parentInstanceId });
        if (!parent?.tokens.some((t) => t.childInstanceId === instance.id)) {
          followUps.push(() => this.cancel(instance.id, 'orphaned: the calling instance does not wait for it'));
          continue;
        }
      }
      if (changed) await this.save(instance);
      if (instance.tokens.some((t) => t.state === 'READY')) {
        this.log.log(`resuming instance ${instance.id}`);
        void this.run(instance.id);
      }
    }
    for (const followUp of followUps) await followUp().catch((e) => this.log.warn(errorMessage(e)));
  }
}
