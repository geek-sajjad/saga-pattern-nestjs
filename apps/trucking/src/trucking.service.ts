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
import { TruckBooking } from './truck-booking.entity';

/** Road distance from the port of Rotterdam, in km. */
const DISTANCE_FROM_RTM_KM: Record<string, number> = {
  duisburg: 230,
  frankfurt: 450,
  hamburg: 470,
  leipzig: 640,
  berlin: 660,
  munich: 830,
};
const EUR_PER_KM = 2.1;
/** One container per truck, and we only have this many on the lane this week. */
const TRUCKS_AVAILABLE = 5;

@Injectable()
export class TruckingService {
  private readonly logger = new Logger(SERVICES.TRUCKING);

  constructor(@InjectRepository(TruckBooking) private readonly bookings: Repository<TruckBooking>) {}

  async book(cmd: StepCommand): Promise<StepResult> {
    const { sagaId, shipment, context } = cmd;

    const existing = await this.bookings.findOneBy({ sagaId });
    if (existing?.status === 'BOOKED') return this.toResult(existing);
    if (existing?.status === 'CANCELLED') {
      throw businessError('ALREADY_CANCELLED', `truck order for saga ${sagaId} was already cancelled`);
    }

    failIfRequested(SERVICES.TRUCKING, cmd);

    const city = shipment.finalDestinationCity.toLowerCase();
    const distance = DISTANCE_FROM_RTM_KM[city];
    if (!distance) {
      throw businessError('NO_ROUTE', `we don't drive from ${shipment.destinationPort} to ${shipment.finalDestinationCity}`);
    }
    if (shipment.containers > TRUCKS_AVAILABLE) {
      throw businessError(
        'NO_TRUCKS_AVAILABLE',
        `${shipment.containers} trucks needed, only ${TRUCKS_AVAILABLE} available this week`,
      );
    }

    // Pick-up is planned from the vessel ETA (output of the ocean step), plus 2 days for customs.
    const eta = context['ocean-carrier']?.eta as string | undefined;
    const pickup = addDays(eta ? new Date(eta) : new Date(), 2);
    const delivery = addDays(pickup, 1);

    const booking = this.bookings.create({
      sagaId,
      orderNumber: `TRK-${Date.now().toString().slice(-6)}`,
      trucks: shipment.containers,
      pickupPort: shipment.destinationPort,
      deliveryCity: shipment.finalDestinationCity,
      pickupDate: toDate(pickup),
      deliveryDate: toDate(delivery),
      priceEur: Math.round(distance * EUR_PER_KM * shipment.containers),
      status: 'BOOKED',
      cancelReason: null,
    });
    await this.bookings.save(booking);
    this.logger.log(
      `[${sagaId}] BOOKED ${booking.trucks} trucks ${booking.pickupPort} -> ${booking.deliveryCity} on ${booking.pickupDate} (${booking.orderNumber})`,
    );
    return this.toResult(booking);
  }

  async cancel(cmd: CompensateCommand): Promise<CompensationResult> {
    const { sagaId, reason } = cmd;
    flakyCompensationIfRequested(SERVICES.TRUCKING, cmd);

    const existing = await this.bookings.findOneBy({ sagaId });
    if (!existing) {
      await this.bookings.save(this.bookings.create({ sagaId, status: 'CANCELLED', cancelReason: reason }));
      return { reference: null, status: 'NOTHING_TO_CANCEL' };
    }
    if (existing.status === 'CANCELLED') return { reference: existing.orderNumber, status: 'ALREADY_CANCELLED' };

    existing.status = 'CANCELLED';
    existing.cancelReason = reason;
    await this.bookings.save(existing);
    this.logger.warn(`[${sagaId}] CANCELLED truck order ${existing.orderNumber}`);
    return { reference: existing.orderNumber, status: 'CANCELLED' };
  }

  findAll() {
    return this.bookings.find({ order: { id: 'DESC' } });
  }

  private toResult(b: TruckBooking): StepResult {
    return {
      reference: b.orderNumber!,
      costEur: b.priceEur!,
      pickupDate: b.pickupDate,
      deliveryDate: b.deliveryDate,
    };
  }
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
