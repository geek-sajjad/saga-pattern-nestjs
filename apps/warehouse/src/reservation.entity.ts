import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ReservationStatus = 'RESERVED' | 'RELEASED';

@Entity('space_reservations')
export class SpaceReservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sagaId: string;

  @Column({ type: 'varchar', nullable: true })
  reservationNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  site: string | null;

  @Column({ type: 'integer', nullable: true })
  pallets: number | null;

  @Column({ type: 'varchar', nullable: true })
  fromDate: string | null;

  @Column({ type: 'real', nullable: true })
  weeklyRateEur: number | null;

  @Column({ type: 'varchar' })
  status: ReservationStatus;

  @Column({ type: 'varchar', nullable: true })
  releaseReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
