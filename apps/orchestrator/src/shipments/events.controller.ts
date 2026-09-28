import { Controller, Get, MessageEvent, Sse } from '@nestjs/common';
import { interval, map, merge, Observable } from 'rxjs';
import { SERVICE_PORTS, ServiceName } from '@app/common';
import { ParticipantClients } from '../saga/participant-clients';
import { SagaEvents } from '../saga/saga-events';
import { SagaOrchestrator } from '../saga/saga-orchestrator.service';
import { LIST_PATTERNS } from './shipments.controller';

/** Endpoints used by the live UI (apps/orchestrator/public/index.html). */
@Controller()
export class EventsController {
  constructor(
    private readonly events: SagaEvents,
    private readonly orchestrator: SagaOrchestrator,
    private readonly participants: ParticipantClients,
  ) {}

  /** Live stream of everything the orchestrator does (Server-Sent Events). */
  @Sse('events')
  stream(): Observable<MessageEvent> {
    const heartbeat = interval(15000).pipe(map(() => ({ type: 'ping', data: {} })));
    const events = this.events.stream.pipe(map((e) => ({ type: 'saga', data: e })));
    return merge(events, heartbeat);
  }

  /** The saga definition: the ordered (Tᵢ, Cᵢ) pairs. */
  @Get('saga-definition')
  definition() {
    return this.orchestrator.definition;
  }

  /** Is each participant reachable over TCP? */
  @Get('services')
  async services() {
    const services = Object.keys(SERVICE_PORTS) as ServiceName[];
    const entries = await Promise.all(
      services.map(async (service) => {
        const res = await this.participants.send(service, LIST_PATTERNS[service], {});
        return [service, { port: SERVICE_PORTS[service], up: res.outcome === 'SUCCEEDED', error: res.error ?? null }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}
