import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  businessError,
  CompensateCommand,
  CompensationResult,
  ContainerType,
  failIfRequested,
  flakyCompensationIfRequested,
  SERVICES,
  StepCommand,
  StepResult,
} from '@app/common';
import { OceanBooking } from './booking.entity';

const MAX_CONTAINERS_PER_BOOKING = 10;
const SUPPORTED_ROUTES = ['CNSHA-NLRTM', 'CNNGB-NLRTM', 'CNSHA-DEHAM'];
const FREIGHT_EUR: Record<ContainerType, number> = { '20GP': 1200, '40GP': 1800, '40HC': 2000 };
const TRANSIT_DAYS = 32;

@Injectable()
export class OceanCarrierService {
  private readonly logger = new Logger(SERVICES.OCEAN_CARRIER);

  constructor(@InjectRepository(OceanBooking) private readonly bookings: Repository<OceanBooking>) {}

  async book(cmd: StepCommand): Promise<StepResult> {
    const { sagaId, shipment } = cmd;

    // Idempotency: the orchestrator may retry, so the same saga must never book twice.
    const existing = await this.bookings.findOneBy({ sagaId });
    if (existing?.status === 'BOOKED') {
      this.logger.log(`[${sagaId}] duplicate request, returning existing booking ${existing.bookingNumber}`);
      return this.toResult(existing);
    }
    // The compensation arrived before this request (timeout, out of order): never resurrect it.
    if (existing?.status === 'CANCELLED') {
      throw businessError('ALREADY_CANCELLED', `booking for saga ${sagaId} was already cancelled`);
    }

    failIfRequested(SERVICES.OCEAN_CARRIER, cmd);

    const route = `${shipment.originPort}-${shipment.destinationPort}`;
    if (!SUPPORTED_ROUTES.includes(route)) {
      throw businessError('ROUTE_NOT_SERVED', `no sailing on route ${route}`);
    }
    if (shipment.containers > MAX_CONTAINERS_PER_BOOKING) {
      throw businessError(
        'VESSEL_FULL',
        `only ${MAX_CONTAINERS_PER_BOOKING} container slots left, requested ${shipment.containers}`,
      );
    }

    const etd = daysFromNow(5);
    const booking = this.bookings.create({
      sagaId,
      bookingNumber: `MSCU${Date.now().toString().slice(-7)}`,
      vessel: 'MSC AURORA / 042W',
      containers: shipment.containers,
      containerType: shipment.containerType,
      route,
      etd: etd.toISOString().slice(0, 10),
      eta: addDays(etd, TRANSIT_DAYS).toISOString().slice(0, 10),
      freightEur: FREIGHT_EUR[shipment.containerType] * shipment.containers,
      status: 'BOOKED',
      cancelReason: null,
    });
    await this.bookings.save(booking);
    this.logger.log(`[${sagaId}] BOOKED ${booking.containers}x${booking.containerType} on ${booking.vessel} -> ${booking.bookingNumber}`);
    return this.toResult(booking);
  }

  async cancel(cmd: CompensateCommand): Promise<CompensationResult> {
    const { sagaId, reason } = cmd;
    flakyCompensationIfRequested(SERVICES.OCEAN_CARRIER, cmd);

    const existing = await this.bookings.findOneBy({ sagaId });
    if (!existing) {
      // Nothing was booked, but leave a tombstone so a late "book" request is rejected.
      await this.bookings.save(this.bookings.create({ sagaId, status: 'CANCELLED', cancelReason: reason }));
      this.logger.warn(`[${sagaId}] cancel for unknown booking, stored tombstone`);
      return { reference: null, status: 'NOTHING_TO_CANCEL' };
    }
    if (existing.status === 'CANCELLED') {
      return { reference: existing.bookingNumber, status: 'ALREADY_CANCELLED' }; // idempotent
    }
    existing.status = 'CANCELLED';
    existing.cancelReason = reason;
    await this.bookings.save(existing);
    this.logger.warn(`[${sagaId}] CANCELLED booking ${existing.bookingNumber}, slots released`);
    return { reference: existing.bookingNumber, status: 'CANCELLED' };
  }

  findAll() {
    return this.bookings.find({ order: { id: 'DESC' } });
  }

  private toResult(b: OceanBooking): StepResult {
    return {
      reference: b.bookingNumber!,
      costEur: b.freightEur!,
      vessel: b.vessel,
      etd: b.etd,
      eta: b.eta,
    };
  }
}

function daysFromNow(days: number): Date {
  return addDays(new Date(), days);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
