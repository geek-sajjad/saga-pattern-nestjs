import { ServiceName } from './services';

export type ContainerType = '20GP' | '40GP' | '40HC';

/** What the customer asks the forwarder for. */
export interface ShipmentDetails {
  customerId: string;
  containers: number;
  containerType: ContainerType;
  /** UN/LOCODE, e.g. CNSHA = Shanghai */
  originPort: string;
  /** UN/LOCODE, e.g. NLRTM = Rotterdam */
  destinationPort: string;
  /** Final inland destination (the German warehouse city). */
  finalDestinationCity: string;
  cargoDescription: string;
  /** Harmonized System code of the goods, used by customs. */
  hsCode: string;
  cargoValueEur: number;
  /** Knobs to make the demo fail in interesting ways. */
  simulate?: FailureSimulation;
}

export interface FailureSimulation {
  /** This service rejects the forward action. */
  failAt?: ServiceName;
  /**
   * This service DOES perform the action but replies too late, so the
   * orchestrator times out without knowing the outcome.
   */
  slowReplyAt?: ServiceName;
  /** This service's compensation fails the first 2 attempts (tests retries). */
  flakyCompensationAt?: ServiceName;
}

/** Forward command sent by the orchestrator to a participant. */
export interface StepCommand {
  sagaId: string;
  shipment: ShipmentDetails;
  /** Results of the steps that already succeeded (the saga "context"). */
  context: SagaContext;
}

/** Compensating command sent by the orchestrator to a participant. */
export interface CompensateCommand {
  sagaId: string;
  shipment: ShipmentDetails;
  reason: string;
}

/** What every participant replies after a successful forward action. */
export interface StepResult {
  reference: string;
  costEur: number;
  [key: string]: unknown;
}

export interface CompensationResult {
  reference: string | null;
  status: string;
  note?: string;
}

export type SagaContext = Partial<Record<ServiceName, StepResult>>;
