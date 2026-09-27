import { badRequest } from '../services/errors.js';

// Decimal input as an exact string, or null when blank and allowed.
export function decimalInput(value, label, { required = false, min = 0, maxDp = 4 } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw badRequest(`${label} is required.`);
    return null;
  }
  const s = String(value).trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw badRequest(`${label} must be a number.`);
  if (Number(s) < min) throw badRequest(`${label} cannot be less than ${min}.`);
  const dp = (s.split('.')[1] || '').length;
  if (dp > maxDp) throw badRequest(`${label} allows at most ${maxDp} decimal places.`);
  return s;
}

export const text = (v) => (v === undefined ? undefined : String(v ?? '').trim());

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
