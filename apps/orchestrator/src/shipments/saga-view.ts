import { SagaStepLog } from '../saga/saga-step-log.entity';
import { Saga } from '../saga/saga.entity';
import { SagaStepDefinition } from '../saga/shipment-saga.definition';

const ICONS: Record<string, string> = { SUCCEEDED: '✔', REJECTED: '✘', TIMEOUT: '⏱', UNREACHABLE: '⚡' };

/** A human-friendly rendering of a saga and its step log. */
export function toSagaView(saga: Saga, logs: SagaStepLog[], definition: SagaStepDefinition[]) {
  const label = (service: string, direction: string) => {
    const step = definition.find((s) => s.service === service);
    return direction === 'FORWARD' ? step?.action : step?.compensation;
  };

  return {
    id: saga.id,
    status: saga.status,
    failedStep: saga.failedStep,
    failureReason: saga.failureReason,
    shipment: saga.payload,
    timeline: logs.map((l) => {
      const arrow = l.direction === 'FORWARD' ? '→' : '↩';
      const retry = l.attempt > 1 ? ` (attempt ${l.attempt})` : '';
      const detail = l.outcome === 'SUCCEEDED' ? summarize(l.response) : l.error;
      return `${ICONS[l.outcome]} ${arrow} [${l.service}] ${label(l.service, l.direction)}${retry}: ${detail} · ${l.durationMs}ms`;
    }),
    /** Structured version of `timeline`, used by the live UI. */
    steps: logs.map((l) => ({
      service: l.service,
      direction: l.direction,
      pattern: l.pattern,
      attempt: l.attempt,
      outcome: l.outcome,
      response: l.response,
      error: l.error,
      durationMs: l.durationMs,
      at: l.createdAt,
    })),
    completedSteps: saga.completedSteps,
    lastStepOutcomeUnknown: saga.lastStepOutcomeUnknown,
    context: saga.context,
    createdAt: saga.createdAt,
    updatedAt: saga.updatedAt,
  };
}

function summarize(response: unknown): string {
  const r = response as Record<string, unknown> | null;
  if (!r) return 'ok';
  const parts = [r.reference && `ref ${r.reference}`, r.status, r.totalEur && `total EUR ${r.totalEur}`];
  return parts.filter(Boolean).join(', ') || 'ok';
}
