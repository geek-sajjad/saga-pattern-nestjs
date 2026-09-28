import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SERVICES, sqliteFor } from '@app/common';
import { TruckBooking } from './truck-booking.entity';
import { TruckingController } from './trucking.controller';
import { TruckingService } from './trucking.service';

@Module({
  imports: [sqliteFor(SERVICES.TRUCKING, [TruckBooking]), TypeOrmModule.forFeature([TruckBooking])],
  controllers: [TruckingController],
  providers: [TruckingService],
})
export class TruckingModule {}
