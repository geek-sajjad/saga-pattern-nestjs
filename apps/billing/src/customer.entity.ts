import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('customers')
export class Customer {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column({ type: 'real' })
  creditLimitEur: number;
}
