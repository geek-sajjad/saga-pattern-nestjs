import 'reflect-metadata';
import { bootstrapParticipant, SERVICES } from '@app/common';
import { BillingModule } from './billing.module';

bootstrapParticipant(BillingModule, SERVICES.BILLING);
