import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SERVICES, sqliteFor } from '@app/common';
import { SpaceReservation } from './reservation.entity';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';

@Module({
  imports: [sqliteFor(SERVICES.WAREHOUSE, [SpaceReservation]), TypeOrmModule.forFeature([SpaceReservation])],
  controllers: [WarehouseController],
  providers: [WarehouseService],
})
export class WarehouseModule {}
