import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { BpmnEngine } from './engine/bpmn-engine.service';

export const PROCESSES_DIR = join(process.cwd(), 'apps', 'bpmn-engine', 'processes');

/**
 * Deploys every .bpmn file in apps/bpmn-engine/processes on boot. Edit a file, restart, get a new version.
 * Files are deployed in name order, so `customs-clearance.v1.bpmn` becomes v1 and `.v2.bpmn` becomes v2.
 */
@Injectable()
export class SampleProcesses implements OnApplicationBootstrap {
  constructor(private readonly engine: BpmnEngine) {}

  async onApplicationBootstrap() {
    for (const file of readdirSync(PROCESSES_DIR).filter((f) => f.endsWith('.bpmn')).sort()) {
      try {
        await this.engine.deploy(readFileSync(join(PROCESSES_DIR, file), 'utf8'));
      } catch (err) {
        new Logger('samples').error(`${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
