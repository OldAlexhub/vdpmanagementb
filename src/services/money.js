// Exact decimal helpers. All money, rate and hour math goes through here — never JS floats.
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const D = (value) => {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return new Decimal(0);
  // Mongo Decimal128 and similar objects stringify exactly.
  return new Decimal(typeof value === 'object' ? value.toString() : value);
};

export const isBlank = (value) => value === null || value === undefined || value === '';

// Business rounding boundary for money: half-up to cents.
export const cents = (value) => D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const sum = (values) => values.reduce((acc, v) => acc.plus(D(v)), new Decimal(0));

export const max = (a, b) => Decimal.max(D(a), D(b));
export const min = (a, b) => Decimal.min(D(a), D(b));

// Serialise for API/snapshot: strings keep exactness.
export const str = (value) => (isBlank(value) ? null : D(value).toString());
export const money = (value) => cents(value).toFixed(2);

// Display helpers used in explanation text (server generated, so formatting is consistent).
export const fmtMoney = (value) => {
  const n = cents(value);
  const [int, frac] = n.abs().toFixed(2).split('.');
  return `${n.isNegative() ? '-' : ''}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
};
export const fmtRate = (value) => {
  const d = D(value);
  const dp = Math.max(2, d.decimalPlaces());
  return `$${d.toFixed(dp)}`;
};
export const fmtNum = (value, maxDp = 6) => {
  const d = D(value).toDecimalPlaces(maxDp);
  return d.toString();
};

export { Decimal };
