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
import { SpaceReservation } from './reservation.entity';

/** Our warehouse network in Germany (note: no Berlin or Leipzig site). */
const SITES: Record<string, { name: string; freePallets: number }> = {
  duisburg: { name: 'DE-DUI-01 Logport', freePallets: 400 },
  hamburg: { name: 'DE-HAM-02 Altenwerder', freePallets: 150 },
  frankfurt: { name: 'DE-FRA-01 Cargo City', freePallets: 200 },
  munich: { name: 'DE-MUC-01 Riem', freePallets: 60 },
};
const PALLETS_PER_CONTAINER: Record<ContainerType, number> = { '20GP': 11, '40GP': 23, '40HC': 24 };
const EUR_PER_PALLET_WEEK = 6.5;

@Injectable()
export class WarehouseService {
  private readonly logger = new Logger(SERVICES.WAREHOUSE);

  constructor(
    @InjectRepository(SpaceReservation) private readonly reservations: Repository<SpaceReservation>,
  ) {}

  async reserve(cmd: StepCommand): Promise<StepResult> {
    const { sagaId, shipment, context } = cmd;

    const existing = await this.reservations.findOneBy({ sagaId });
    if (existing?.status === 'RESERVED') return this.toResult(existing);
    if (existing?.status === 'RELEASED') {
      throw businessError('ALREADY_RELEASED', `reservation for saga ${sagaId} was already released`);
    }

    failIfRequested(SERVICES.WAREHOUSE, cmd);

    const site = SITES[shipment.finalDestinationCity.toLowerCase()];
    if (!site) {
      throw businessError('NO_WAREHOUSE', `we have no warehouse in ${shipment.finalDestinationCity}`);
    }
    const pallets = PALLETS_PER_CONTAINER[shipment.containerType] * shipment.containers;
    if (pallets > site.freePallets) {
      throw businessError('WAREHOUSE_FULL', `${site.name} has ${site.freePallets} free pallet places, need ${pallets}`);
    }

    // Space is needed from the truck delivery date (output of the trucking step).
    const fromDate = (context.trucking?.deliveryDate as string | undefined) ?? new Date().toISOString().slice(0, 10);

    const reservation = this.reservations.create({
      sagaId,
      reservationNumber: `WH-${Date.now().toString().slice(-6)}`,
      site: site.name,
      pallets,
      fromDate,
      weeklyRateEur: Math.round(pallets * EUR_PER_PALLET_WEEK * 100) / 100,
      status: 'RESERVED',
      releaseReason: null,
    });
    await this.reservations.save(reservation);
    this.logger.log(`[${sagaId}] RESERVED ${pallets} pallet places at ${site.name} from ${fromDate}`);
    return this.toResult(reservation);
  }

  async release(cmd: CompensateCommand): Promise<CompensationResult> {
    const { sagaId, reason } = cmd;
    flakyCompensationIfRequested(SERVICES.WAREHOUSE, cmd);

    const existing = await this.reservations.findOneBy({ sagaId });
    if (!existing) {
      await this.reservations.save(this.reservations.create({ sagaId, status: 'RELEASED', releaseReason: reason }));
      return { reference: null, status: 'NOTHING_TO_RELEASE' };
    }
    if (existing.status === 'RELEASED') return { reference: existing.reservationNumber, status: 'ALREADY_RELEASED' };

    existing.status = 'RELEASED';
    existing.releaseReason = reason;
    await this.reservations.save(existing);
    this.logger.warn(`[${sagaId}] RELEASED reservation ${existing.reservationNumber}`);
    return { reference: existing.reservationNumber, status: 'RELEASED' };
  }

  findAll() {
    return this.reservations.find({ order: { id: 'DESC' } });
  }

  private toResult(r: SpaceReservation): StepResult {
    // The customer is billed for the first 2 weeks of storage up front.
    return {
      reference: r.reservationNumber!,
      costEur: r.weeklyRateEur! * 2,
      site: r.site,
      pallets: r.pallets,
      fromDate: r.fromDate,
    };
  }
}
