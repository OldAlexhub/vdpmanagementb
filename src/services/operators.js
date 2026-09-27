// A provider's operators as plain values. Providers saved before operators existed
// are read as one operator built from their provider-level operator, routes and lease.
import { str } from './money.js';
import { isoDate } from './cycleService.js';

export const LEGACY_OPERATOR_ID = 'default';

const transferOf = (t) => (t?.providerId
  ? { providerId: String(t.providerId), providerName: t.providerName, effectiveDate: t.effectiveDate, note: t.note || '' }
  : null);

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
      startDate: o.startDate || null,
      endDate: o.endDate || null,
      transferredFrom: transferOf(o.transferredFrom),
      transferredTo: transferOf(o.transferredTo),
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
    startDate: null,
    endDate: null,
    transferredFrom: null,
    transferredTo: null,
  }];
}

// Date checks on YYYY-MM-DD strings (they sort as dates).
export const worksOn = (o, day) => (!o.startDate || o.startDate <= day) && (!o.endDate || o.endDate >= day);
export const worksBetween = (o, from, to) => (!o.startDate || o.startDate <= to) && (!o.endDate || o.endDate >= from);

/** Active operators; with a cycle, only those working for the provider at some point in it. */
export function activeOperators(provider, cycle) {
  const ops = operatorsOf(provider).filter((o) => o.status === 'ACTIVE');
  if (!cycle) return ops;
  return ops.filter((o) => worksBetween(o, isoDate(cycle.cycleStart), isoDate(cycle.cycleEnd)));
}

/** Does this provider run the route on this day (per its operators' dates)? */
export const runsRouteOn = (provider, route, day) =>
  operatorsOf(provider).some((o) => o.status === 'ACTIVE' && o.routes.includes(route) && worksOn(o, day));

/**
 * Lift-lease weeks for an operator who joined or left inside the cycle: a week is charged
 * to whoever has the operator on its first day, so a transfer never charges a week twice.
 * Null = the whole cycle (the normal case).
 */
export function leaseWeeksInCycle(o, cycle) {
  const starts = [cycle.week1Start, cycle.week2Start].map(isoDate);
  const charged = starts.filter((d) => worksOn(o, d)).length;
  return charged === starts.length ? null : String(charged);
}
