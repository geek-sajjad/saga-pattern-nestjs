/**
 * Every independent party in the shipment has its own service, its own
 * TCP port and its own SQLite database. The orchestrator (the forwarder)
 * is the only one that knows about all of them.
 */
export const SERVICES = {
  OCEAN_CARRIER: 'ocean-carrier',
  CUSTOMS: 'customs',
  TRUCKING: 'trucking',
  WAREHOUSE: 'warehouse',
  BILLING: 'billing',
} as const;

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

export const SERVICE_PORTS: Record<ServiceName, number> = {
  'ocean-carrier': 4001,
  customs: 4002,
  trucking: 4003,
  warehouse: 4004,
  billing: 4005,
};

export const ORCHESTRATOR_HTTP_PORT = 3000;

/** Injection tokens for the orchestrator's TCP clients. */
export const CLIENT_TOKENS: Record<ServiceName, string> = {
  'ocean-carrier': 'OCEAN_CARRIER_CLIENT',
  customs: 'CUSTOMS_CLIENT',
  trucking: 'TRUCKING_CLIENT',
  warehouse: 'WAREHOUSE_CLIENT',
  billing: 'BILLING_CLIENT',
};
