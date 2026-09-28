import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { CLIENT_TOKENS, ServiceName } from '@app/common';
import type { StepOutcome } from './saga-step-log.entity';

export interface CallOutcome<T = unknown> {
  outcome: StepOutcome;
  data?: T;
  error?: string;
  durationMs: number;
}

export const STEP_TIMEOUT_MS = Number(process.env.SAGA_STEP_TIMEOUT_MS ?? 3000);

/** Sends a command to a participant and classifies what happened. */
@Injectable()
export class ParticipantClients {
  private readonly clients: Record<ServiceName, ClientProxy>;

  constructor(
    @Inject(CLIENT_TOKENS['ocean-carrier']) ocean: ClientProxy,
    @Inject(CLIENT_TOKENS.customs) customs: ClientProxy,
    @Inject(CLIENT_TOKENS.trucking) trucking: ClientProxy,
    @Inject(CLIENT_TOKENS.warehouse) warehouse: ClientProxy,
    @Inject(CLIENT_TOKENS.billing) billing: ClientProxy,
  ) {
    this.clients = { 'ocean-carrier': ocean, customs, trucking, warehouse, billing };
  }

  async send<T>(service: ServiceName, pattern: string, payload: unknown): Promise<CallOutcome<T>> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    try {
      const data = await firstValueFrom(
        this.clients[service].send<T>(pattern, payload).pipe(timeout(STEP_TIMEOUT_MS)),
      );
      return { outcome: 'SUCCEEDED', data, durationMs: elapsed() };
    } catch (err: any) {
      if (err instanceof TimeoutError) {
        // The most important case in distributed systems: we DON'T KNOW if it worked.
        return { outcome: 'TIMEOUT', error: `no reply within ${STEP_TIMEOUT_MS}ms, outcome unknown`, durationMs: elapsed() };
      }
      if (err?.code === 'ECONNREFUSED') {
        // The message never reached the service, so we know nothing happened.
        return { outcome: 'UNREACHABLE', error: `${service} is not running (ECONNREFUSED)`, durationMs: elapsed() };
      }
      const message = err?.message ?? JSON.stringify(err);
      return { outcome: 'REJECTED', error: err?.code ? `${err.code}: ${message}` : message, durationMs: elapsed() };
    }
  }
}
