import 'reflect-metadata';
import { bootstrapParticipant, SERVICES } from '@app/common';
import { CustomsModule } from './customs.module';

bootstrapParticipant(CustomsModule, SERVICES.CUSTOMS);
