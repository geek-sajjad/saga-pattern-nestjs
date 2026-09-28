import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type DeclarationStatus = 'FILED' | 'WITHDRAWN';

@Entity('customs_declarations')
export class CustomsDeclaration {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  sagaId: string;

  /** Movement Reference Number issued by EU customs. */
  @Column({ type: 'varchar', nullable: true })
  mrn: string | null;

  @Column({ type: 'varchar', nullable: true })
  hsCode: string | null;

  @Column({ type: 'real', nullable: true })
  cargoValueEur: number | null;

  @Column({ type: 'real', nullable: true })
  dutyEur: number | null;

  @Column({ type: 'real', nullable: true })
  brokerageFeeEur: number | null;

  @Column({ type: 'varchar' })
  status: DeclarationStatus;

  @Column({ type: 'varchar', nullable: true })
  withdrawReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
