import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { SagaContext, ServiceName, ShipmentDetails } from '@app/common';
import type { SagaStatus } from './saga.entity';
import type { StepDirection, StepOutcome } from './saga-step-log.entity';

/** A snapshot of the orchestrator's durable saga state, emitted every time it is persisted. */
export interface SagaSnapshot {
  id: string;
  status: SagaStatus;
  completedSteps: number;
  lastStepOutcomeUnknown: boolean;
  failedStep: ServiceName | null;
  failureReason: string | null;
  context: SagaContext;
  payload: ShipmentDetails;
}

export type SagaEvent =
  | { type: 'saga.persisted'; sagaId: string; saga: SagaSnapshot }
  | { type: 'compensation.plan'; sagaId: string; services: ServiceName[] }
  | { type: 'step.sent'; sagaId: string; service: ServiceName; direction: StepDirection; pattern: string; attempt: number }
  | {
      type: 'step.result';
      sagaId: string;
      service: ServiceName;
      direction: StepDirection;
      pattern: string;
      attempt: number;
      outcome: StepOutcome;
      response: unknown;
      error: string | null;
      durationMs: number;
    };

/**
 * In-process event bus used only for observability (the live UI).
 * The saga itself never depends on it: the saga log in SQLite stays the source of truth.
 */
@Injectable()
export class SagaEvents {
  private readonly subject = new Subject<SagaEvent & { at: string }>();

  emit(event: SagaEvent): void {
    this.subject.next({ ...event, at: new Date().toISOString() });
  }

  get stream(): Observable<SagaEvent & { at: string }> {
    return this.subject.asObservable();
  }
}
