import 'reflect-metadata';
import { bootstrapParticipant, SERVICES } from '@app/common';
import { TruckingModule } from './trucking.module';

bootstrapParticipant(TruckingModule, SERVICES.TRUCKING);
