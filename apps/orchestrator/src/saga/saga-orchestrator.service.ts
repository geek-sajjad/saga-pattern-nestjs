import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompensateCommand, CompensationResult, ShipmentDetails, sleep, StepCommand, StepResult } from '@app/common';
import { ParticipantClients } from './participant-clients';
import { SagaEvents } from './saga-events';
import { Saga } from './saga.entity';
import { SagaStepLog, StepDirection } from './saga-step-log.entity';
import { SagaStepDefinition, SHIPMENT_SAGA } from './shipment-saga.definition';

/** Artificial pause before each step, handy for the crash-recovery demo. */
const STEP_DELAY_MS = Number(process.env.SAGA_STEP_DELAY_MS ?? 0);
const COMPENSATION_MAX_ATTEMPTS = Number(process.env.SAGA_COMPENSATION_MAX_ATTEMPTS ?? 5);
const COMPENSATION_BACKOFF_MS = 500;

@Injectable()
export class SagaOrchestrator {
  private readonly logger = new Logger('orchestrator');
  private readonly steps = SHIPMENT_SAGA;

  constructor(
    @InjectRepository(Saga) private readonly sagas: Repository<Saga>,
    @InjectRepository(SagaStepLog) private readonly logs: Repository<SagaStepLog>,
    private readonly participants: ParticipantClients,
    private readonly events: SagaEvents,
  ) {}

  /** Start a new saga and run it to a final state. */
  async start(shipment: ShipmentDetails): Promise<Saga> {
    const saga = await this.persist(
      this.sagas.create({ status: 'STARTED', payload: shipment, context: {}, completedSteps: 0 }),
    );
    this.logger.log(`[${saga.id}] ▶ saga STARTED: ${shipment.containers}x${shipment.containerType} ${shipment.originPort} → ${shipment.destinationPort} → ${shipment.finalDestinationCity}`);
    await this.executeForward(saga);
    return saga;
  }

  /** Run T1..Tn in order; on the first failure, switch to compensation. */
  private async executeForward(saga: Saga): Promise<void> {
    for (let i = saga.completedSteps; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (STEP_DELAY_MS) await sleep(STEP_DELAY_MS);

      const cmd: StepCommand = { sagaId: saga.id, shipment: saga.payload, context: saga.context };
      const result = await this.call<StepResult>(saga, step, 'FORWARD', 1, cmd);

      if (result.outcome === 'SUCCEEDED') {
        this.logger.log(`[${saga.id}]   ✔ ${step.action}: ${result.data!.reference}`);
        // Persist progress BEFORE moving on. This is what makes the saga recoverable.
        saga.context = { ...saga.context, [step.service]: result.data };
        saga.completedSteps = i + 1;
        await this.persist(saga);
        continue;
      }

      this.logger.error(`[${saga.id}]   ✘ ${step.action} ${result.outcome}: ${result.error}`);
      saga.status = 'COMPENSATING';
      saga.failedStep = step.service;
      saga.failureReason = `${step.service} ${result.outcome}: ${result.error}`;
      // A rejection or an unreachable service means nothing happened there.
      // A timeout means it MIGHT have happened, so we compensate that step as well.
      saga.lastStepOutcomeUnknown = result.outcome === 'TIMEOUT';
      await this.persist(saga);
      await this.compensate(saga);
      return;
    }

    saga.status = 'COMPLETED';
    await this.persist(saga);
    this.logger.log(`[${saga.id}] ■ saga COMPLETED`);
  }

  /**
   * Run the compensations for every step that (maybe) took effect, in reverse order.
   * Compensations must eventually succeed, so they are retried with backoff.
   * Participants make them idempotent, so retrying is always safe.
   */
  async compensate(saga: Saga): Promise<void> {
    const count = Math.min(saga.completedSteps + (saga.lastStepOutcomeUnknown ? 1 : 0), this.steps.length);
    const toUndo = this.steps.slice(0, count).reverse();
    this.events.emit({ type: 'compensation.plan', sagaId: saga.id, services: toUndo.map((s) => s.service) });
    this.logger.warn(`[${saga.id}] ↩ COMPENSATING ${toUndo.length} step(s): ${toUndo.map((s) => s.service).join(' → ') || 'nothing to undo'}`);

    const alreadyUndone = await this.alreadyCompensated(saga.id);
    let allUndone = true;

    for (const step of toUndo) {
      if (alreadyUndone.has(step.service)) continue; // resumed after a crash
      const cmd: CompensateCommand = {
        sagaId: saga.id,
        shipment: saga.payload,
        reason: saga.failureReason ?? 'saga aborted',
      };

      let done = false;
      for (let attempt = 1; attempt <= COMPENSATION_MAX_ATTEMPTS && !done; attempt++) {
        const result = await this.call<CompensationResult>(saga, step, 'COMPENSATE', attempt, cmd);
        done = result.outcome === 'SUCCEEDED';
        if (done) {
          this.logger.warn(`[${saga.id}]   ↩ ${step.compensation}: ${result.data!.status}`);
        } else {
          this.logger.error(`[${saga.id}]   ✘ ${step.compensation} attempt ${attempt}/${COMPENSATION_MAX_ATTEMPTS}: ${result.error}`);
          if (attempt < COMPENSATION_MAX_ATTEMPTS) await sleep(COMPENSATION_BACKOFF_MS * attempt);
        }
      }
      // Keep undoing the other steps even if this one is stuck.
      if (!done) allUndone = false;
    }

    saga.status = allUndone ? 'COMPENSATED' : 'COMPENSATION_FAILED';
    await this.persist(saga);
    if (allUndone) this.logger.warn(`[${saga.id}] ■ saga COMPENSATED (rolled back)`);
    else this.logger.error(`[${saga.id}] ■ saga COMPENSATION_FAILED, manual intervention required`);
  }

  /** Retry a saga whose compensation got stuck (e.g. after the participant came back up). */
  async retryCompensation(id: string): Promise<Saga> {
    const saga = await this.findOne(id);
    if (saga.status !== 'COMPENSATION_FAILED') {
      throw new NotFoundException(`saga ${id} is ${saga.status}, only COMPENSATION_FAILED sagas can be retried`);
    }
    saga.status = 'COMPENSATING';
    await this.persist(saga);
    await this.compensate(saga);
    return saga;
  }

  /**
   * Called on boot. A saga left in STARTED or COMPENSATING means the orchestrator
   * died mid-flight. We use backward recovery: undo whatever may have happened.
   */
  async recoverUnfinished(): Promise<void> {
    const unfinished = await this.sagas.find({ where: [{ status: 'STARTED' }, { status: 'COMPENSATING' }] });
    if (unfinished.length === 0) return;
    this.logger.warn(`found ${unfinished.length} unfinished saga(s) from a previous run, recovering`);

    for (const saga of unfinished) {
      if (saga.status === 'STARTED') {
        if (saga.completedSteps >= this.steps.length) {
          saga.status = 'COMPLETED'; // crashed right after the last step
          await this.persist(saga);
          continue;
        }
        saga.status = 'COMPENSATING';
        saga.failedStep = this.steps[saga.completedSteps].service;
        saga.failureReason = 'orchestrator crashed while this step was in flight';
        saga.lastStepOutcomeUnknown = true;
        await this.persist(saga);
      }
      this.logger.warn(`[${saga.id}] recovering (completed steps: ${saga.completedSteps})`);
      await this.compensate(saga);
    }
  }

  findAll(): Promise<Saga[]> {
    return this.sagas.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Saga> {
    const saga = await this.sagas.findOneBy({ id });
    if (!saga) throw new NotFoundException(`saga ${id} not found`);
    return saga;
  }

  findLogs(sagaId: string): Promise<SagaStepLog[]> {
    return this.logs.find({ where: { sagaId }, order: { id: 'ASC' } });
  }

  get definition(): SagaStepDefinition[] {
    return this.steps;
  }

  private async alreadyCompensated(sagaId: string): Promise<Set<string>> {
    const done = await this.logs.find({ where: { sagaId, direction: 'COMPENSATE', outcome: 'SUCCEEDED' } });
    return new Set(done.map((l) => l.service));
  }

  /** Save the saga state and tell observers (the live UI) about it. */
  private async persist(saga: Saga): Promise<Saga> {
    const saved = await this.sagas.save(saga);
    const { id, status, completedSteps, lastStepOutcomeUnknown, failedStep, failureReason, context, payload } = saved;
    this.events.emit({
      type: 'saga.persisted',
      sagaId: id,
      saga: { id, status, completedSteps, lastStepOutcomeUnknown, failedStep: failedStep ?? null, failureReason: failureReason ?? null, context, payload },
    });
    return saved;
  }

  /** Send one command to a participant, record it in the saga log and publish it to observers. */
  private async call<T>(saga: Saga, step: SagaStepDefinition, direction: StepDirection, attempt: number, cmd: unknown) {
    const pattern = direction === 'FORWARD' ? step.executePattern : step.compensatePattern;
    this.events.emit({ type: 'step.sent', sagaId: saga.id, service: step.service, direction, pattern, attempt });
    const result = await this.participants.send<T>(step.service, pattern, cmd);
    await this.log(saga, step, direction, attempt, result);
    this.events.emit({
      type: 'step.result',
      sagaId: saga.id,
      service: step.service,
      direction,
      pattern,
      attempt,
      outcome: result.outcome,
      response: result.data ?? null,
      error: result.error ?? null,
      durationMs: result.durationMs,
    });
    return result;
  }

  private log(
    saga: Saga,
    step: SagaStepDefinition,
    direction: StepDirection,
    attempt: number,
    result: { outcome: SagaStepLog['outcome']; data?: unknown; error?: string; durationMs: number },
  ) {
    return this.logs.save(
      this.logs.create({
        sagaId: saga.id,
        service: step.service,
        direction,
        pattern: direction === 'FORWARD' ? step.executePattern : step.compensatePattern,
        attempt,
        outcome: result.outcome,
        response: result.data ?? null,
        error: result.error ?? null,
        durationMs: result.durationMs,
      }),
    );
  }
}
