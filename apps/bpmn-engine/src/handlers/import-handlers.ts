import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HandlerContext, HandlerRegistry } from '../engine/handlers';
import { shipmentOf } from './freight-handlers';

/** Release of customs-clearance.bpmn an import uses unless the order says otherwise (see its call activity). */
const DEFAULT_CUSTOMS_RELEASE = '2026.2';

/** Goods that need an export-control check: radar (8526), aircraft parts (8803), weapons (9301). */
const DUAL_USE_HS_PREFIXES = ['8526', '8803', '9301'];
/** Ports under embargo in this demo. */
const EMBARGOED_PORTS = ['IRBND', 'KPNNP'];

/** EU import duty by HS chapter (simplified). */
const DUTY_RATE_BY_CHAPTER: Record<string, number> = { '85': 0.027, '84': 0.017, '94': 0.022, '61': 0.12 };

/**
 * The glue code behind import-shipment.bpmn and customs-clearance.bpmn.
 *
 * The bookings reuse the participant handlers from freight-handlers.ts
 * (ocean.book, warehouse.reserve, …). These handlers are pure business logic
 * with no remote calls, so the interesting parts stay in the diagrams: the
 * escalation timers, the messages, the sub-process, the call activity and the
 * loops over containers.
 */
@Injectable()
export class ImportHandlers implements OnModuleInit {
  private readonly log = new Logger('import');

  constructor(private readonly registry: HandlerRegistry) {}

  onModuleInit() {
    const r = (name: string, fn: (ctx: HandlerContext) => Record<string, unknown> | void) => this.registry.register(name, fn);

    // ── import-shipment.bpmn ──
    r('order.register', ({ instanceId, variables }) => {
      const s = shipmentOf(variables);
      const shipmentRef = variables.shipmentRef ?? `IMP-${instanceId.slice(0, 6).toUpperCase()}`;
      // One entry per container: the multi-instance activities loop over this list.
      const base = parseInt(instanceId.slice(0, 6), 16) % 9_000_000;
      const containerList = Array.from({ length: s.containers }, (_, i) => ({ number: `MSKU${String(1_000_000 + base + i).slice(-7)}`, seq: i + 1, type: s.containerType }));
      return { shipment: s, shipmentRef, containerList, customsRelease: variables.customsRelease ?? DEFAULT_CUSTOMS_RELEASE };
    });

    r('risk.score', ({ variables }) => {
      const s = shipmentOf(variables);
      const reasons: string[] = [];
      let score = 0;
      if (EMBARGOED_PORTS.includes(s.originPort)) (score += 100), reasons.push(`origin ${s.originPort} is embargoed`);
      if (DUAL_USE_HS_PREFIXES.some((p) => s.hsCode.startsWith(p))) (score += 50), reasons.push(`HS ${s.hsCode} is dual-use`);
      if (s.cargoValueEur > 200_000) (score += 40), reasons.push(`cargo value EUR ${s.cargoValueEur} > 200,000`);
      if (s.cargoValueEur > 500_000) (score += 20), reasons.push('cargo value > 500,000');
      const level = score >= 100 ? 'blocked' : score >= 40 ? 'high' : 'low';
      return { risk: { score, level, reasons } };
    });

    r('compliance.remind', ({ instanceId, variables }) => {
      this.log.log(`[${instanceId.slice(0, 8)}] reminding compliance: ${variables.shipmentRef} still waits for a review`);
      return { complianceReminders: (variables.complianceReminders ?? 0) + 1 };
    });

    r('customer.notify', ({ instanceId, nodeId, variables }) => {
      const text: Record<string, string> = {
        Task_NotifyCustomsSlow: 'customs clearance takes longer than usual',
        Task_NotifyDelay: 'the vessel is late; we keep watching it',
        Task_NotifySeized: 'customs seized the cargo; all bookings were cancelled',
        Task_NotifyRefused: 'we cannot accept this order (compliance)',
      };
      const message = text[nodeId] ?? nodeId;
      this.log.log(`[${instanceId.slice(0, 8)}] emailing customer about ${variables.shipmentRef}: ${message}`);
      return { notifications: [...(variables.notifications ?? []), { at: new Date().toISOString(), message }] };
    });

    r('delivery.updateAddress', ({ variables }) => {
      // The new address arrives as the payload of the AddressChanged message.
      const address = variables.newAddress ?? 'unknown address';
      return { shipment: { ...shipmentOf(variables), deliveryAddress: address }, addressChanges: (variables.addressChanges ?? 0) + 1 };
    });

    // Runs once PER CONTAINER (multi-instance). `container` and `loopCounter` are the iteration's own variables.
    r('delivery.plan', ({ variables }) => {
      const { container, loopCounter } = variables;
      const day = new Date(Date.now() + (2 + Math.floor(loopCounter / 2)) * 86_400_000).toISOString().slice(0, 10);
      const window = loopCounter % 2 === 0 ? '08:00-12:00' : '13:00-17:00';
      return { slot: { container: container.number, day, window, address: variables.shipment?.deliveryAddress ?? shipmentOf(variables).finalDestinationCity } };
    });

    r('claims.open', ({ variables }) => {
      const damaged = (variables.proofsOfDelivery ?? []).filter((p: any) => p?.damaged);
      return { claim: { reference: `CLM-${Date.now().toString().slice(-6)}`, containers: damaged.map((p: any) => p.container), status: 'OPEN' } };
    });

    // ── customs-clearance.bpmn (called by import-shipment, but can run on its own) ──
    r('customs.declare', ({ instanceId, variables }) => {
      const s = shipmentOf(variables);
      const rate = DUTY_RATE_BY_CHAPTER[s.hsCode.slice(0, 2)] ?? 0.04;
      // Started on its own (not called by import-shipment)? Then it needs its own key for the message correlation.
      const shipmentRef = variables.shipmentRef ?? `CUS-${instanceId.slice(0, 6).toUpperCase()}`;
      return {
        shipmentRef,
        customs: {
          declarationNo: `ATLAS-${shipmentRef}-${Date.now().toString().slice(-4)}`,
          dutyEur: Math.round(s.cargoValueEur * rate),
          status: 'SUBMITTED',
          chased: 0,
        },
      };
    });

    r('customs.chaseBroker', ({ instanceId, variables }) => {
      this.log.log(`[${instanceId.slice(0, 8)}] chasing the customs broker about ${variables.customs?.declarationNo}`);
      return { customs: { ...variables.customs, chased: (variables.customs?.chased ?? 0) + 1 } };
    });

    r('customs.recordRelease', ({ variables }) => ({
      customs: { ...variables.customs, status: 'RELEASED', releasedAt: new Date().toISOString(), inspection: variables.inspection },
    }));

    r('customs.recordInspection', ({ variables }) => ({
      inspection: { passed: variables.passed === true, findings: variables.findings ?? '', at: new Date().toISOString() },
    }));
  }
}
