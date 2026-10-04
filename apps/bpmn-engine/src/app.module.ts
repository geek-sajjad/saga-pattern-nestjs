import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { CLIENT_TOKENS, SERVICE_PORTS, ServiceName } from '@app/common';
import { BpmnEngine } from './engine/bpmn-engine.service';
import { Deployment, ProcessInstance } from './engine/entities';
import { HandlerRegistry } from './engine/handlers';
import { FreightHandlers } from './handlers/freight-handlers';
import { ImportHandlers } from './handlers/import-handlers';
import { BpmnController } from './http/bpmn.controller';
import { SampleProcesses } from './sample-processes';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(process.cwd(), 'data', 'bpmn-engine.sqlite'),
      entities: [Deployment, ProcessInstance],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Deployment, ProcessInstance]),
    // Same TCP clients as the orchestrator: the service tasks call the real participants.
    ClientsModule.register(
      (Object.keys(SERVICE_PORTS) as ServiceName[]).map((service) => ({
        name: CLIENT_TOKENS[service],
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port: SERVICE_PORTS[service] },
      })),
    ),
  ],
  controllers: [BpmnController],
  providers: [BpmnEngine, HandlerRegistry, FreightHandlers, ImportHandlers, SampleProcesses],
})
export class AppModule {}
