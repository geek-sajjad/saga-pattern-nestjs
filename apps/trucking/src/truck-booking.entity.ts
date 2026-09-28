import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TruckBookingStatus = 'BOOKED' | 'CANCELLED';

@Entity('truck_bookings')
export class TruckBooking {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sagaId: string;

  @Column({ type: 'varchar', nullable: true })
  orderNumber: string | null;

  @Column({ type: 'integer', nullable: true })
  trucks: number | null;

  @Column({ type: 'varchar', nullable: true })
  pickupPort: string | null;

  @Column({ type: 'varchar', nullable: true })
  deliveryCity: string | null;

  @Column({ type: 'varchar', nullable: true })
  pickupDate: string | null;

  @Column({ type: 'varchar', nullable: true })
  deliveryDate: string | null;

  @Column({ type: 'real', nullable: true })
  priceEur: number | null;

  @Column({ type: 'varchar' })
  status: TruckBookingStatus;

  @Column({ type: 'varchar', nullable: true })
  cancelReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
