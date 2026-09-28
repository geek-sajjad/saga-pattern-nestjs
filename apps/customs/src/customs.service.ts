import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  businessError,
  CompensateCommand,
  CompensationResult,
  failIfRequested,
  flakyCompensationIfRequested,
  SERVICES,
  StepCommand,
  StepResult,
} from '@app/common';
import { CustomsDeclaration } from './declaration.entity';

/** HS chapter 93 = arms and ammunition. */
const PROHIBITED_HS_CHAPTERS = ['93'];
const DUTY_RATE = 0.04;
const BROKERAGE_FEE_EUR = 250;

@Injectable()
export class CustomsService {
  private readonly logger = new Logger(SERVICES.CUSTOMS);

  constructor(
    @InjectRepository(CustomsDeclaration) private readonly declarations: Repository<CustomsDeclaration>,
  ) {}

  async file(cmd: StepCommand): Promise<StepResult> {
    const { sagaId, shipment, context } = cmd;

    const existing = await this.declarations.findOneBy({ sagaId });
    if (existing?.status === 'FILED') return this.toResult(existing);
    if (existing?.status === 'WITHDRAWN') {
      throw businessError('ALREADY_WITHDRAWN', `declaration for saga ${sagaId} was already withdrawn`);
    }

    failIfRequested(SERVICES.CUSTOMS, cmd);

    if (PROHIBITED_HS_CHAPTERS.includes(shipment.hsCode.slice(0, 2))) {
      throw businessError('PROHIBITED_GOODS', `HS code ${shipment.hsCode} cannot be imported without a licence`);
    }
    // The declaration references the ocean booking from the previous step (saga context).
    const oceanRef = context['ocean-carrier']?.reference;
    if (!oceanRef) {
      throw businessError('MISSING_TRANSPORT_DOC', 'an ocean booking is required to file an import declaration');
    }

    const declaration = this.declarations.create({
      sagaId,
      mrn: `26NL${Date.now().toString().slice(-10)}`,
      hsCode: shipment.hsCode,
      cargoValueEur: shipment.cargoValueEur,
      dutyEur: Math.round(shipment.cargoValueEur * DUTY_RATE * 100) / 100,
      brokerageFeeEur: BROKERAGE_FEE_EUR,
      status: 'FILED',
      withdrawReason: null,
    });
    await this.declarations.save(declaration);
    this.logger.log(`[${sagaId}] FILED import declaration ${declaration.mrn} for B/L ${oceanRef}`);
    return this.toResult(declaration);
  }

  async withdraw(cmd: CompensateCommand): Promise<CompensationResult> {
    const { sagaId, reason } = cmd;
    flakyCompensationIfRequested(SERVICES.CUSTOMS, cmd);

    const existing = await this.declarations.findOneBy({ sagaId });
    if (!existing) {
      await this.declarations.save(this.declarations.create({ sagaId, status: 'WITHDRAWN', withdrawReason: reason }));
      return { reference: null, status: 'NOTHING_TO_WITHDRAW' };
    }
    if (existing.status === 'WITHDRAWN') return { reference: existing.mrn, status: 'ALREADY_WITHDRAWN' };

    existing.status = 'WITHDRAWN';
    existing.withdrawReason = reason;
    await this.declarations.save(existing);
    this.logger.warn(`[${sagaId}] WITHDRAWN declaration ${existing.mrn}`);
    return { reference: existing.mrn, status: 'WITHDRAWN' };
  }

  findAll() {
    return this.declarations.find({ order: { id: 'DESC' } });
  }

  private toResult(d: CustomsDeclaration): StepResult {
    return {
      reference: d.mrn!,
      costEur: d.brokerageFeeEur! + d.dutyEur!,
      dutyEur: d.dutyEur,
      brokerageFeeEur: d.brokerageFeeEur,
    };
  }
}
