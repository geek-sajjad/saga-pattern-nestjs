import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type InvoiceStatus = 'CHARGED' | 'REFUNDED';

export interface InvoiceLine {
  description: string;
  reference: string;
  amountEur: number;
}

@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sagaId: string;

  @Column({ type: 'varchar', nullable: true })
  invoiceNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  customerId: string | null;

  @Column({ type: 'simple-json', nullable: true })
  lines: InvoiceLine[] | null;

  @Column({ type: 'real', nullable: true })
  totalEur: number | null;

  @Column({ type: 'varchar' })
  status: InvoiceStatus;

  @Column({ type: 'varchar', nullable: true })
  refundReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
