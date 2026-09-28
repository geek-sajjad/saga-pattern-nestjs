import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { ServiceName } from '@app/common';
import { Saga } from './saga.entity';

export type StepDirection = 'FORWARD' | 'COMPENSATE';
export type StepOutcome = 'SUCCEEDED' | 'REJECTED' | 'TIMEOUT' | 'UNREACHABLE';

/**
 * Append-only audit trail of every message the orchestrator sent.
 * (Deliberately no `Saga.logs` inverse relation: saving a Saga with a stale
 * `logs` array would make TypeORM delete the log rows it doesn't contain.)
 */
@Entity('saga_step_logs')
export class SagaStepLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sagaId: string;

  @ManyToOne(() => Saga, { onDelete: 'CASCADE' })
  saga: Saga;

  @Column({ type: 'varchar' })
  service: ServiceName;

  @Column({ type: 'varchar' })
  direction: StepDirection;

  @Column()
  pattern: string;

  @Column({ type: 'integer', default: 1 })
  attempt: number;

  @Column({ type: 'varchar' })
  outcome: StepOutcome;

  @Column({ type: 'simple-json', nullable: true })
  response: unknown;

  @Column({ type: 'varchar', nullable: true })
  error: string | null;

  @Column({ type: 'integer' })
  durationMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
