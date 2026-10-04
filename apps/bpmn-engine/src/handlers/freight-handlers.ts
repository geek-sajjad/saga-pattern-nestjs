import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { CLIENT_TOKENS, PATTERNS, SagaContext, ServiceName, ShipmentDetails } from '@app/common';
import { BpmnError, HandlerContext, HandlerRegistry } from '../engine/handlers';

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

const RATE_PER_CONTAINER_EUR = { '20GP': 1800, '40GP': 3000, '40HC': 3200 };
const CALL_TIMEOUT_MS = 3000;

/**
 * The "glue code" behind the diagrams in apps/bpmn-engine/processes.
 *
 * Each handler is tiny on purpose: the ORDER of the steps, the branching and
 * the compensation all live in the BPMN diagram, not here. Compare with
 * apps/orchestrator, where the same saga is hand-coded in TypeScript.
 */
@Injectable()
export class FreightHandlers implements OnModuleInit {
  private readonly log = new Logger('handlers');
  private readonly clients: Record<ServiceName, ClientProxy>;

  constructor(
    private readonly registry: HandlerRegistry,
    @Inject(CLIENT_TOKENS['ocean-carrier']) ocean: ClientProxy,
    @Inject(CLIENT_TOKENS.customs) customs: ClientProxy,
    @Inject(CLIENT_TOKENS.trucking) trucking: ClientProxy,
    @Inject(CLIENT_TOKENS.warehouse) warehouse: ClientProxy,
    @Inject(CLIENT_TOKENS.billing) billing: ClientProxy,
  ) {
    this.clients = { 'ocean-carrier': ocean, customs, trucking, warehouse, billing };
  }

  onModuleInit() {
    // ── quote-approval.bpmn: no external services, just logic ──
    this.registry.register('quote.calculate', ({ variables }) => {
      const s = shipmentOf(variables);
      const amount = s.containers * RATE_PER_CONTAINER_EUR[s.containerType];
      return { quote: { amount, currency: 'EUR', perContainer: RATE_PER_CONTAINER_EUR[s.containerType] } };
    });
    this.registry.register('sales.notify', ({ instanceId, variables }) => {
      this.log.log(`[${instanceId.slice(0, 8)}] telling sales: quote of EUR ${variables.quote?.amount} accepted`);
      return { salesNotifiedAt: new Date().toISOString() };
    });
    this.registry.register('customer.sendRejection', ({ instanceId, variables }) => {
      this.log.log(`[${instanceId.slice(0, 8)}] emailing customer: quote rejected (${variables.comment ?? 'no comment'})`);
    });

    // ── shipment-saga.bpmn: the same five participants the orchestrator uses ──
    this.registry.register('ocean.book', this.forward('ocean-carrier', PATTERNS.OCEAN_CARRIER.BOOK));
    this.registry.register('ocean.cancel', this.undo('ocean-carrier', PATTERNS.OCEAN_CARRIER.CANCEL));
    this.registry.register('customs.file', this.forward('customs', PATTERNS.CUSTOMS.FILE));
    this.registry.register('customs.withdraw', this.undo('customs', PATTERNS.CUSTOMS.WITHDRAW));
    this.registry.register('trucking.book', this.forward('trucking', PATTERNS.TRUCKING.BOOK));
    this.registry.register('trucking.cancel', this.undo('trucking', PATTERNS.TRUCKING.CANCEL));
    this.registry.register('warehouse.reserve', this.forward('warehouse', PATTERNS.WAREHOUSE.RESERVE));
    this.registry.register('warehouse.release', this.undo('warehouse', PATTERNS.WAREHOUSE.RELEASE));
    this.registry.register('billing.charge', this.forward('billing', PATTERNS.BILLING.CHARGE));
    this.registry.register('billing.refund', this.undo('billing', PATTERNS.BILLING.REFUND));
  }

  /** A forward step: send the command, store the reply in `context.<service>`. */
  private forward(service: ServiceName, pattern: string) {
    return async ({ instanceId, variables }: HandlerContext) => {
      const context: SagaContext = variables.context ?? {};
      const result = await this.call(service, pattern, { sagaId: instanceId, shipment: shipmentOf(variables), context });
      return { context: { ...context, [service]: result } };
    };
  }

  /** A compensation step. The instance id doubles as the saga id, so participants stay idempotent. */
  private undo(service: ServiceName, pattern: string) {
    return async ({ instanceId, variables }: HandlerContext) => {
      const result = await this.call(service, pattern, { sagaId: instanceId, shipment: shipmentOf(variables), reason: variables.lastError?.message ?? 'process compensation' });
      return { compensations: { ...(variables.compensations ?? {}), [service]: result } };
    };
  }

  /**
   * Translate transport outcomes into the engine's two kinds of failure:
   *  - participant said no (vessel full, credit limit…) → BpmnError, handled by the diagram
   *  - participant down or silent                          → plain Error, becomes an incident
   */
  private async call(service: ServiceName, pattern: string, payload: unknown) {
    try {
      return await firstValueFrom(this.clients[service].send(pattern, payload).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err: any) {
      if (err instanceof TimeoutError) throw new Error(`${service} did not reply within ${CALL_TIMEOUT_MS}ms (outcome unknown)`);
      if (err?.code === 'ECONNREFUSED') throw new Error(`${service} is not running (ECONNREFUSED); start it and retry`);
      throw new BpmnError('BOOKING_REJECTED', `${service}: ${err?.message ?? JSON.stringify(err)}`);
    }
  }
}

export function shipmentOf(variables: Record<string, any>): ShipmentDetails {
  return { ...DEFAULT_SHIPMENT, ...(variables.shipment ?? {}) };
}
