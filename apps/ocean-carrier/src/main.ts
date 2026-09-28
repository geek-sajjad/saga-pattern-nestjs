import 'reflect-metadata';
import { bootstrapParticipant, SERVICES } from '@app/common';
import { OceanCarrierModule } from './ocean-carrier.module';

bootstrapParticipant(OceanCarrierModule, SERVICES.OCEAN_CARRIER);
