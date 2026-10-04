import { BadRequestException, Body, Controller, Get, Header, MessageEvent, Param, Post, Put, Query, Sse } from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { BpmnValidationError } from '../engine/bpmn-parser';
import { BpmnEngine } from '../engine/bpmn-engine.service';
import { ProcessInstance } from '../engine/entities';
import { HandlerRegistry } from '../engine/handlers';

interface MigrateBody {
  targetVersion?: number;
  mapping?: Record<string, string>;
  dryRun?: boolean;
}

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

  /** Move every running instance of one version to another: {fromVersion, targetVersion, mapping?, dryRun?}. */
  @Post('processes/:key/migrate')
  migrateAll(@Param('key') key: string, @Body() body: MigrateBody & { fromVersion?: number }) {
    if (!body?.fromVersion || !body?.targetVersion) throw new BadRequestException('body must be {"fromVersion": 1, "targetVersion": 2, "mapping"?: {…}, "dryRun"?: true}');
    return this.engine.migrateAll(key, Number(body.fromVersion), Number(body.targetVersion), body.mapping ?? {}, !!body.dryRun);
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
    return all.map((i) => ({
      id: i.id,
      definitionKey: i.definitionKey,
      definitionVersion: i.definitionVersion,
      status: i.status,
      parentInstanceId: i.parentInstanceId,
      incidents: i.tokens.filter((t) => t.state === 'INCIDENT').length,
      waiting: [...new Set(i.tokens.filter((t) => t.state === 'WAITING' && !this.isContainer(t)).map((t) => t.nodeId))],
      createdAt: i.createdAt,
    }));
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

  /** {targetVersion, mapping?: {"oldNodeId": "newNodeId"}, dryRun?: true} */
  @Post('instances/:id/migrate')
  migrate(@Param('id') id: string, @Body() body: MigrateBody) {
    if (!body?.targetVersion) throw new BadRequestException('body must be {"targetVersion": 2, "mapping"?: {…}, "dryRun"?: true}');
    return this.engine.migrate(id, Number(body.targetVersion), body.mapping ?? {}, !!body.dryRun);
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

  /** A token that only holds a scope open (sub-process, loop body, call activity): its work is shown elsewhere. */
  private isContainer(t: ProcessInstance['tokens'][number]) {
    return !!t.loop || !!t.childInstanceId;
  }

  /** The instance plus what the UI needs: open user tasks, timers and message subscriptions, called instances. */
  private async view(instance: ProcessInstance) {
    const def = await this.engine.definition(instance.definitionKey, instance.definitionVersion);
    const label = (id: string) => def.nodes[id]?.name ?? id;
    const userTasks = instance.tokens
      .filter((t) => t.state === 'WAITING' && def.nodes[t.nodeId].type === 'userTask' && !t.loop)
      .map((t) => {
        const loop = def.nodes[t.nodeId].loop;
        const item = loop && t.locals ? t.locals[loop.elementVariable] : undefined;
        return { tokenId: t.id, nodeId: t.nodeId, name: label(t.nodeId), formFields: def.nodes[t.nodeId].formFields ?? [], iteration: loop ? { index: t.loopIndex, item } : undefined };
      });
    const subscriptions = instance.tokens.flatMap((t) =>
      (t.subscriptions ?? []).map((s) => ({ ...s, tokenId: t.id, waitingAt: label(t.nodeId), eventName: label(s.eventId) })),
    );
    const children = (await this.engine.children(instance.id)).map((c) => ({ id: c.id, definitionKey: c.definitionKey, definitionVersion: c.definitionVersion, status: c.status }));
    return { ...instance, versionTag: def.versionTag ?? null, userTasks, subscriptions, children };
  }
}
