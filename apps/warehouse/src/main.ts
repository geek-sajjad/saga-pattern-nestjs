import 'reflect-metadata';
import { bootstrapParticipant, SERVICES } from '@app/common';
import { WarehouseModule } from './warehouse.module';

bootstrapParticipant(WarehouseModule, SERVICES.WAREHOUSE);
