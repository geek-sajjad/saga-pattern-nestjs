import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OceanBookingStatus = 'BOOKED' | 'CANCELLED';

@Entity('ocean_bookings')
export class OceanBooking {
  @PrimaryGeneratedColumn()
  id: number;

  /** One booking per saga. The unique key makes the service idempotent. */
  @Column({ unique: true })
  sagaId: string;

  @Column({ type: 'varchar', nullable: true })
  bookingNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  vessel: string | null;

  @Column({ type: 'integer', nullable: true })
  containers: number | null;

  @Column({ type: 'varchar', nullable: true })
  containerType: string | null;

  @Column({ type: 'varchar', nullable: true })
  route: string | null;

  @Column({ type: 'varchar', nullable: true })
  etd: string | null;

  @Column({ type: 'varchar', nullable: true })
  eta: string | null;

  @Column({ type: 'real', nullable: true })
  freightEur: number | null;

  @Column({ type: 'varchar' })
  status: OceanBookingStatus;

  @Column({ type: 'varchar', nullable: true })
  cancelReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
