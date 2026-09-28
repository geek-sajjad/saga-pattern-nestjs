/**
 * Message patterns (the "commands") each participant accepts.
 *
 * Every forward action has a matching compensating action. That pairing is
 * the heart of the SAGA pattern: there are no distributed transactions and
 * no rollback, only a semantic "undo" that each service implements itself.
 */
export const PATTERNS = {
  OCEAN_CARRIER: { BOOK: 'ocean.book-slots', CANCEL: 'ocean.cancel-booking' },
  CUSTOMS: { FILE: 'customs.file-declaration', WITHDRAW: 'customs.withdraw-declaration' },
  TRUCKING: { BOOK: 'trucking.book-truck', CANCEL: 'trucking.cancel-truck' },
  WAREHOUSE: { RESERVE: 'warehouse.reserve-space', RELEASE: 'warehouse.release-space' },
  BILLING: { CHARGE: 'billing.charge-customer', REFUND: 'billing.refund-customer' },
} as const;
