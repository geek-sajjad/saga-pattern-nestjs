import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { SagaOrchestrator } from './saga-orchestrator.service';

@Injectable()
export class SagaRecovery implements OnApplicationBootstrap {
  constructor(private readonly orchestrator: SagaOrchestrator) {}

  onApplicationBootstrap() {
    // Don't block startup; compensations retry until participants are reachable.
    setTimeout(() => void this.orchestrator.recoverUnfinished(), 1000);
  }
}
