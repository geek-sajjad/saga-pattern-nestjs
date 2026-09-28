import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CLIENT_TOKENS, SERVICE_PORTS, ServiceName } from '@app/common';
import { ParticipantClients } from './participant-clients';
import { SagaOrchestrator } from './saga-orchestrator.service';
import { SagaEvents } from './saga-events';
import { SagaRecovery } from './saga-recovery.service';
import { SagaStepLog } from './saga-step-log.entity';
import { Saga } from './saga.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Saga, SagaStepLog]),
    ClientsModule.register(
      (Object.keys(SERVICE_PORTS) as ServiceName[]).map((service) => ({
        name: CLIENT_TOKENS[service],
        transport: Transport.TCP,
        options: { host: '127.0.0.1', port: SERVICE_PORTS[service] },
      })),
    ),
  ],
  providers: [ParticipantClients, SagaOrchestrator, SagaRecovery, SagaEvents],
  exports: [SagaOrchestrator, ParticipantClients, SagaEvents],
})
export class SagaModule {}
