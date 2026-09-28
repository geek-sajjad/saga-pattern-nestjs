import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { SagaStepLog } from './saga/saga-step-log.entity';
import { Saga } from './saga/saga.entity';
import { SagaModule } from './saga/saga.module';
import { EventsController } from './shipments/events.controller';
import { ShipmentsController } from './shipments/shipments.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(process.cwd(), 'data', 'orchestrator.sqlite'),
      entities: [Saga, SagaStepLog],
      synchronize: true,
    }),
    SagaModule,
  ],
  controllers: [ShipmentsController, EventsController],
})
export class AppModule {}
