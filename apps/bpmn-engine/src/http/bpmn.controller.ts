import { BadRequestException, Body, Controller, Get, Header, MessageEvent, Param, Post, Put, Query, Sse } from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { BpmnEngine } from '../engine/bpmn-engine.service';
import { ProcessInstance, Wait } from '../engine/entities';
import { HandlerRegistry } from '../engine/handlers';
import { BpmnValidationError } from '../engine/process-model';

/** The engine's REST API. Camunda, Flowable and friends expose much the same set of calls. */
@Controller('api')
export class BpmnController {
  constructor(
    private readonly engine: BpmnEngine,
    private readonly handlers: HandlerRegistry,
  ) {}

  // ── repository: deployed process definitions and their versions ──

  @Get('processes')
  processes() {
    return this.engine.listDeployments();
  }

  @Get('processes/:key/xml')
  @Header('content-type', 'application/xml')
  async xml(@Param('key') key: string, @Query('version') version?: string) {
    return (await this.engine.getDeployment(key, version ? Number(version) : undefined)).xml;
  }

  /** e.g. GET /api/processes/customs-clearance/diff?from=1&to=2 */
  @Get('processes/:key/diff')
  diff(@Param('key') key: string, @Query('from') from: string, @Query('to') to: string) {
    if (!Number(from) || !Number(to)) throw new BadRequestException('query must be ?from=<version>&to=<version>');
    return this.engine.diff(key, Number(from), Number(to));
  }

  @Post('processes')
  async deploy(@Body() body: { xml?: string }) {
    if (!body?.xml) throw new BadRequestException('body must be {"xml": "<bpmn:definitions …>"}');
    try {
      const { xml, ...deployment } = await this.engine.deploy(body.xml);
      return deployment;
    } catch (err) {
      if (err instanceof BpmnValidationError) throw new BadRequestException({ message: 'invalid BPMN', problems: err.problems });
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  /** Body: {variables, version?, versionTag?}. Without version/versionTag the latest version starts. */
  @Post('processes/:key/start')
  async start(@Param('key') key: string, @Body() body: { variables?: Record<string, unknown>; version?: number; versionTag?: string }) {
    const pin = { version: body?.version ? Number(body.version) : undefined, versionTag: body?.versionTag || undefined };
    return this.view(await this.engine.start(key, body?.variables ?? {}, pin));
  }

  @Get('handlers')
  handlerNames() {
    return this.handlers.names();
  }

  // ── messages: how the outside world talks to waiting processes ──

  /** e.g. {"name": "VesselArrived", "correlationKey": "IMP-1A2B3C", "variables": {"berth": "ECT Delta"}} */
  @Post('messages')
  message(@Body() body: { name?: string; correlationKey?: string; variables?: Record<string, unknown> }) {
    if (!body?.name) throw new BadRequestException('body must be {"name": "…", "correlationKey"?: "…", "variables"?: {…}}');
    return this.engine.correlateMessage(body.name, body.correlationKey ?? undefined, body.variables ?? {});
  }

  // ── runtime: process instances ──

  @Get('instances')
  async instances() {
    const all = await this.engine.listInstances();
    return Promise.all(
      all.map(async (i) => {
        const model = await this.engine.model(i.definitionKey, i.definitionVersion);
        // Boundary events wait on behalf of their activity, which is already in the list.
        const waitingAt = i.waits.filter((w) => w.kind !== 'executing' && w.kind !== 'join' && model.nodes[w.nodeId]?.type !== 'boundaryEvent');
        return {
          id: i.id,
          definitionKey: i.definitionKey,
          definitionVersion: i.definitionVersion,
          status: i.status,
          parentInstanceId: i.parentInstanceId,
          incidents: i.incidents.length,
          waiting: [...new Set(waitingAt.map((w) => w.nodeId))],
          createdAt: i.createdAt,
        };
      }),
    );
  }

  @Get('instances/:id')
  async instance(@Param('id') id: string) {
    return this.view(await this.engine.getInstance(id));
  }

  @Post('instances/:id/tasks/:tokenId/complete')
  async completeTask(@Param('id') id: string, @Param('tokenId') tokenId: string, @Body() body: { variables?: Record<string, unknown> }) {
    await this.engine.completeUserTask(id, tokenId, body?.variables ?? {});
    return { ok: true };
  }

  @Post('instances/:id/incidents/:tokenId/retry')
  async retry(@Param('id') id: string, @Param('tokenId') tokenId: string) {
    await this.engine.retryIncident(id, tokenId);
    return { ok: true };
  }

  @Put('instances/:id/variables')
  async setVariables(@Param('id') id: string, @Body() body: { variables?: Record<string, unknown> }) {
    if (!body?.variables || typeof body.variables !== 'object') throw new BadRequestException('body must be {"variables": {…}}');
    await this.engine.setVariables(id, body.variables);
    return { ok: true };
  }

  @Post('instances/:id/cancel')
  async cancel(@Param('id') id: string) {
    await this.engine.cancel(id);
    return { ok: true };
  }

  /** Live updates for the UI (Server-Sent Events). */
  @Sse('events')
  events(): Observable<MessageEvent> {
    const heartbeat = interval(15000).pipe(map(() => ({ type: 'ping', data: {} })));
    return merge(this.engine.events.pipe(map((e) => ({ type: e.type, data: e }))), heartbeat);
  }

  /**
   * The instance plus what the cockpit needs: where tokens are (to paint the
   * diagram), open user tasks, timers and message subscriptions, called instances.
   */
  private async view(instance: ProcessInstance) {
    const model = await this.engine.model(instance.definitionKey, instance.definitionVersion);
    const label = (id: string) => model.nodes[id]?.name ?? id;
    const { engineState, waits, incidents, ...rest } = instance;

    const tokens = [
      // Timers and messages on boundary events are subscriptions of the activity they sit on, not tokens of their own.
      ...waits
        .filter((w) => model.nodes[w.nodeId]?.type !== 'boundaryEvent' && !incidents.some((i) => i.executionId === w.executionId))
        .map((w) => ({ id: w.executionId, nodeId: w.nodeId, kind: w.kind, state: w.kind === 'executing' ? 'EXECUTING' : 'WAITING' })),
      ...incidents.map((i) => ({ id: i.executionId, nodeId: i.nodeId, kind: 'incident', state: 'INCIDENT', incident: i.message })),
    ];
    const userTasks = waits
      .filter((w) => w.kind === 'user')
      .map((w) => ({ tokenId: w.executionId, nodeId: w.nodeId, name: label(w.nodeId), formFields: model.nodes[w.nodeId]?.formFields ?? [], iteration: w.iteration }));
    const subscriptions = waits
      .filter((w): w is Wait & { kind: 'message' | 'timer' } => w.kind === 'message' || w.kind === 'timer')
      .map((w) => ({
        kind: w.kind,
        tokenId: w.executionId,
        eventId: w.nodeId,
        eventName: label(w.nodeId),
        waitingAt: label(model.nodes[w.nodeId]?.attachedTo ?? w.nodeId),
        messageName: w.messageName,
        correlationKey: w.correlationKey,
        dueAt: w.dueAt,
        interrupting: w.interrupting,
      }));
    const children = (await this.engine.children(instance.id)).map((c) => ({ id: c.id, definitionKey: c.definitionKey, definitionVersion: c.definitionVersion, status: c.status }));
    return { ...rest, versionTag: model.versionTag ?? null, tokens, userTasks, subscriptions, children };
  }
}
