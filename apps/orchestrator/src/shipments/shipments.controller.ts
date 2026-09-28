import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { SERVICE_PORTS, ServiceName, ShipmentDetails } from '@app/common';
import { ParticipantClients } from '../saga/participant-clients';
import { SagaOrchestrator } from '../saga/saga-orchestrator.service';
import { Saga } from '../saga/saga.entity';
import { CreateShipmentDto } from './create-shipment.dto';
import { toSagaView } from './saga-view';

/** The default request: 2 x 40' high cubes of solar panels, Shanghai → Rotterdam → Duisburg. */
const DEFAULT_SHIPMENT: ShipmentDetails = {
  customerId: 'acme-gmbh',
  containers: 2,
  containerType: '40HC',
  originPort: 'CNSHA',
  destinationPort: 'NLRTM',
  finalDestinationCity: 'Duisburg',
  cargoDescription: 'Solar panels',
  hsCode: '854143',
  cargoValueEur: 120000,
};

export const LIST_PATTERNS: Record<ServiceName, string> = {
  'ocean-carrier': 'ocean.list',
  customs: 'customs.list',
  trucking: 'trucking.list',
  warehouse: 'warehouse.list',
  billing: 'billing.list',
};

@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly orchestrator: SagaOrchestrator,
    private readonly participants: ParticipantClients,
  ) {}

  /** Start a shipment saga. The response is returned once the saga reached a final state. */
  @Post()
  async create(@Body() dto: CreateShipmentDto) {
    const saga = await this.orchestrator.start({ ...DEFAULT_SHIPMENT, ...dto });
    return this.view(saga);
  }

  @Get()
  async list() {
    const sagas = await this.orchestrator.findAll();
    return sagas.map((s) => ({
      id: s.id,
      status: s.status,
      route: `${s.payload.containers}x${s.payload.containerType} ${s.payload.originPort} → ${s.payload.destinationPort} → ${s.payload.finalDestinationCity}`,
      customerId: s.payload.customerId,
      failedStep: s.failedStep,
      createdAt: s.createdAt,
    }));
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.view(await this.orchestrator.findOne(id));
  }

  /**
   * Look inside every participant's own database for this saga.
   * Handy to verify that compensations really undid the work.
   */
  @Get(':id/participants')
  async participantsState(@Param('id', ParseUUIDPipe) id: string) {
    const services = Object.keys(SERVICE_PORTS) as ServiceName[];
    const entries = await Promise.all(
      services.map(async (service) => {
        const res = await this.participants.send<{ sagaId: string }[]>(service, LIST_PATTERNS[service], {});
        const record = res.data?.find((r) => r.sagaId === id) ?? (res.error ? { error: res.error } : null);
        return [service, record] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  @Post(':id/retry-compensation')
  @HttpCode(200)
  async retryCompensation(@Param('id', ParseUUIDPipe) id: string) {
    return this.view(await this.orchestrator.retryCompensation(id));
  }

  private async view(saga: Saga) {
    return toSagaView(saga, await this.orchestrator.findLogs(saga.id), this.orchestrator.definition);
  }
}
