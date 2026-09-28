import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SERVICES, sqliteFor } from '@app/common';
import { OceanBooking } from './booking.entity';
import { OceanCarrierController } from './ocean-carrier.controller';
import { OceanCarrierService } from './ocean-carrier.service';

@Module({
  imports: [sqliteFor(SERVICES.OCEAN_CARRIER, [OceanBooking]), TypeOrmModule.forFeature([OceanBooking])],
  controllers: [OceanCarrierController],
  providers: [OceanCarrierService],
})
export class OceanCarrierModule {}
