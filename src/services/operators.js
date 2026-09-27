// A provider's operators as plain values. Providers saved before operators existed
// are read as one operator built from their provider-level operator, routes and lease.
import { str } from './money.js';

export const LEGACY_OPERATOR_ID = 'default';

export function operatorsOf(provider) {
  if (provider?.operators?.length) {
    return provider.operators.map((o) => ({
      id: String(o._id),
      name: o.name,
      routes: [...(o.routes || [])],
      status: o.status || 'ACTIVE',
      contractedHours: str(o.contractedHours),
      liftLease: { amount: str(o.liftLease?.amount), frequency: o.liftLease?.frequency || 'NONE' },
      notes: o.notes || '',
    }));
  }
  if (!provider) return [];
  return [{
    id: LEGACY_OPERATOR_ID,
    name: provider.operatorName || provider.name,
    routes: [...(provider.routes || [])],
    status: 'ACTIVE',
    contractedHours: null,
    liftLease: { amount: str(provider.liftLease?.amount), frequency: provider.liftLease?.frequency || 'NONE' },
    notes: '',
  }];
}

export const activeOperators = (provider) => operatorsOf(provider).filter((o) => o.status === 'ACTIVE');
