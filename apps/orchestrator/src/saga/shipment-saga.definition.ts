import { PATTERNS, SERVICES, ServiceName } from '@app/common';

export interface SagaStepDefinition {
  service: ServiceName;
  /** Forward action (Ti) */
  action: string;
  executePattern: string;
  /** Compensating action (Ci), undoes Ti */
  compensation: string;
  compensatePattern: string;
}

/**
 * The shipment saga: T1 → T2 → T3 → T4 → T5.
 * If Tn fails, the orchestrator runs Cn-1 → … → C1 (reverse order).
 *
 * Ordering matters:
 *  - Reservations that are cheap to cancel go first.
 *  - Billing (charging money) is last: it is the "pivot" step. Once the customer
 *    is charged, nothing after it can fail, so we never have to refund in the
 *    normal flow. Refund still exists for completeness and for manual recovery.
 */
export const SHIPMENT_SAGA: SagaStepDefinition[] = [
  {
    service: SERVICES.OCEAN_CARRIER,
    action: 'Book vessel slots Shanghai → Rotterdam',
    executePattern: PATTERNS.OCEAN_CARRIER.BOOK,
    compensation: 'Cancel ocean booking',
    compensatePattern: PATTERNS.OCEAN_CARRIER.CANCEL,
  },
  {
    service: SERVICES.CUSTOMS,
    action: 'File EU import declaration',
    executePattern: PATTERNS.CUSTOMS.FILE,
    compensation: 'Withdraw import declaration',
    compensatePattern: PATTERNS.CUSTOMS.WITHDRAW,
  },
  {
    service: SERVICES.TRUCKING,
    action: 'Book trucks Rotterdam → German warehouse',
    executePattern: PATTERNS.TRUCKING.BOOK,
    compensation: 'Cancel truck order',
    compensatePattern: PATTERNS.TRUCKING.CANCEL,
  },
  {
    service: SERVICES.WAREHOUSE,
    action: 'Reserve warehouse space',
    executePattern: PATTERNS.WAREHOUSE.RESERVE,
    compensation: 'Release warehouse space',
    compensatePattern: PATTERNS.WAREHOUSE.RELEASE,
  },
  {
    service: SERVICES.BILLING,
    action: 'Charge the customer',
    executePattern: PATTERNS.BILLING.CHARGE,
    compensation: 'Refund the customer',
    compensatePattern: PATTERNS.BILLING.REFUND,
  },
];
