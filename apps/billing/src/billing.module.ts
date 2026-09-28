import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SERVICES, sqliteFor } from '@app/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { Customer } from './customer.entity';
import { Invoice } from './invoice.entity';

@Module({
  imports: [sqliteFor(SERVICES.BILLING, [Invoice, Customer]), TypeOrmModule.forFeature([Invoice, Customer])],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
