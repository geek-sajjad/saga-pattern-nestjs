import { Logger } from '@nestjs/common';
import { businessError } from './errors';
import { ServiceName } from './services';
import { CompensateCommand, StepCommand } from './shipment';

export const SLOW_REPLY_MS = 8000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call at the start of a forward action. */
export function failIfRequested(service: ServiceName, cmd: StepCommand): void {
  if (cmd.shipment.simulate?.failAt === service) {
    throw businessError('SIMULATED_FAILURE', `${service} was asked to reject this request`);
  }
}

/**
 * Call AFTER the forward action is committed. The work is done, but the reply
 * arrives after the orchestrator gave up. This is the classic "unknown outcome"
 * problem and the reason compensations must also cover the step that timed out.
 */
export async function slowReplyIfRequested(service: ServiceName, cmd: StepCommand): Promise<void> {
  if (cmd.shipment.simulate?.slowReplyAt === service) {
    new Logger(service).warn(`[${cmd.sagaId}] work committed, but delaying the reply by ${SLOW_REPLY_MS}ms`);
    await sleep(SLOW_REPLY_MS);
  }
}

const compensationAttempts = new Map<string, number>();

/** Call at the start of a compensation: fails twice, then succeeds. */
export function flakyCompensationIfRequested(service: ServiceName, cmd: CompensateCommand): void {
  if (cmd.shipment.simulate?.flakyCompensationAt !== service) return;
  const attempt = (compensationAttempts.get(cmd.sagaId) ?? 0) + 1;
  compensationAttempts.set(cmd.sagaId, attempt);
  if (attempt <= 2) {
    throw businessError('TEMPORARY_OUTAGE', `${service} compensation attempt ${attempt} failed (simulated)`);
  }
}
