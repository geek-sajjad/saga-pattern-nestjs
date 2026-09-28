import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { SagaContext, ServiceName, ShipmentDetails } from '@app/common';

/**
 * Saga lifecycle:
 *
 *   STARTED ──(all steps ok)──────────────────────────────▶ COMPLETED
 *      │
 *      └─(a step fails)─▶ COMPENSATING ──(all undone)─────▶ COMPENSATED
 *                              │
 *                              └─(an undo keeps failing)─▶ COMPENSATION_FAILED (needs a human)
 */
export type SagaStatus = 'STARTED' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'COMPENSATION_FAILED';

/**
 * The orchestrator's durable memory. Because it is persisted after every step,
 * the orchestrator can crash and still know exactly what has to be undone.
 */
@Entity('sagas')
export class Saga {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: 'ship-container' })
  type: string;

  @Column({ type: 'varchar' })
  status: SagaStatus;

  /** The original request. */
  @Column({ type: 'simple-json' })
  payload: ShipmentDetails;

  /** Results of the steps that succeeded, fed into the following steps. */
  @Column({ type: 'simple-json' })
  context: SagaContext;

  /** Number of steps that have completed successfully. */
  @Column({ type: 'integer', default: 0 })
  completedSteps: number;

  /**
   * True when we don't know whether the step at `completedSteps` took effect
   * (timeout, crash). That step must then be compensated too.
   */
  @Column({ default: false })
  lastStepOutcomeUnknown: boolean;

  @Column({ type: 'varchar', nullable: true })
  failedStep: ServiceName | null;

  @Column({ type: 'varchar', nullable: true })
  failureReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
