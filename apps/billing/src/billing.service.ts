import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  businessError,
  CompensateCommand,
  CompensationResult,
  failIfRequested,
  flakyCompensationIfRequested,
  SagaContext,
  SERVICES,
  StepCommand,
  StepResult,
} from '@app/common';
import { Customer } from './customer.entity';
import { Invoice, InvoiceLine } from './invoice.entity';

const FORWARDER_MARGIN = 0.12;

const SEED_CUSTOMERS: Customer[] = [
  { id: 'acme-gmbh', name: 'ACME GmbH', creditLimitEur: 1_000_000 },
  { id: 'tiny-traders', name: 'Tiny Traders UG', creditLimitEur: 5_000 },
];

const LINE_LABELS: Record<keyof SagaContext, string> = {
  'ocean-carrier': 'Ocean freight CNSHA -> NLRTM',
  customs: 'Customs clearance, brokerage and duty',
  trucking: 'On-carriage by truck',
  warehouse: 'Warehouse storage (2 weeks)',
  billing: 'n/a',
};

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(SERVICES.BILLING);

  constructor(
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {}

  async onModuleInit() {
    await this.customers.save(SEED_CUSTOMERS);
  }

  async charge(cmd: StepCommand): Promise<StepResult> {
    const { sagaId, shipment, context } = cmd;

    const existing = await this.invoices.findOneBy({ sagaId });
    if (existing?.status === 'CHARGED') return this.toResult(existing);
    if (existing?.status === 'REFUNDED') {
      throw businessError('ALREADY_REFUNDED', `invoice for saga ${sagaId} was already refunded`);
    }

    failIfRequested(SERVICES.BILLING, cmd);

    const customer = await this.customers.findOneBy({ id: shipment.customerId });
    if (!customer) throw businessError('UNKNOWN_CUSTOMER', `customer ${shipment.customerId} does not exist`);

    // Build the invoice from what every previous step reported back (the saga context).
    const lines: InvoiceLine[] = (Object.keys(context) as (keyof SagaContext)[]).map((step) => ({
      description: LINE_LABELS[step],
      reference: context[step]!.reference,
      amountEur: context[step]!.costEur,
    }));
    const subtotal = lines.reduce((sum, l) => sum + l.amountEur, 0);
    lines.push({ description: 'Forwarding fee', reference: 'FWD', amountEur: round(subtotal * FORWARDER_MARGIN) });
    const total = round(lines.reduce((sum, l) => sum + l.amountEur, 0));

    const charged = await this.invoices.findBy({ customerId: customer.id, status: 'CHARGED' });
    const outstanding = charged.reduce((sum, i) => sum + (i.totalEur ?? 0), 0);
    const available = customer.creditLimitEur - outstanding;
    if (total > available) {
      throw businessError(
        'CREDIT_LIMIT_EXCEEDED',
        `${customer.name} has EUR ${round(available)} credit left, shipment costs EUR ${total}`,
      );
    }

    const invoice = this.invoices.create({
      sagaId,
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
      customerId: customer.id,
      lines,
      totalEur: total,
      status: 'CHARGED',
      refundReason: null,
    });
    await this.invoices.save(invoice);
    this.logger.log(`[${sagaId}] CHARGED ${customer.name} EUR ${total} (${invoice.invoiceNumber})`);
    return this.toResult(invoice);
  }

  async refund(cmd: CompensateCommand): Promise<CompensationResult> {
    const { sagaId, reason } = cmd;
    flakyCompensationIfRequested(SERVICES.BILLING, cmd);

    const existing = await this.invoices.findOneBy({ sagaId });
    if (!existing) {
      await this.invoices.save(this.invoices.create({ sagaId, status: 'REFUNDED', refundReason: reason }));
      return { reference: null, status: 'NOTHING_TO_REFUND' };
    }
    if (existing.status === 'REFUNDED') return { reference: existing.invoiceNumber, status: 'ALREADY_REFUNDED' };

    existing.status = 'REFUNDED';
    existing.refundReason = reason;
    await this.invoices.save(existing);
    this.logger.warn(`[${sagaId}] REFUNDED invoice ${existing.invoiceNumber}`);
    return { reference: existing.invoiceNumber, status: 'REFUNDED' };
  }

  findAll() {
    return this.invoices.find({ order: { id: 'DESC' } });
  }

  private toResult(i: Invoice): StepResult {
    return { reference: i.invoiceNumber!, costEur: 0, totalEur: i.totalEur, lines: i.lines };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
