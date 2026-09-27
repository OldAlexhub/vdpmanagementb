// Incentive (TUI) tier validation and range-based selection.
import { D, isBlank } from './money.js';

// Largest gap allowed between one tier's maximum and the next tier's minimum
// (e.g. 79.99 → 80). Anything wider leaves percentages with no defined rate.
const MAX_GAP = D('0.01');

export function validateTiers(tiers) {
  const errors = [];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return ['At least one incentive tier is required when TUI is enabled.'];
  }
  tiers.forEach((t, i) => {
    const n = i + 1;
    if (isBlank(t.minimumPercentage)) errors.push(`Tier ${n}: minimum percentage is required.`);
    if (isBlank(t.rate)) errors.push(`Tier ${n}: rate is required.`);
    else if (D(t.rate).lte(0)) errors.push(`Tier ${n}: rate must be greater than zero.`);
    if (!isBlank(t.minimumPercentage) && D(t.minimumPercentage).lt(0)) {
      errors.push(`Tier ${n}: minimum percentage cannot be negative.`);
    }
    if (!isBlank(t.maximumPercentage) && !isBlank(t.minimumPercentage) &&
        D(t.maximumPercentage).lt(D(t.minimumPercentage))) {
      errors.push(`Tier ${n}: maximum is below minimum.`);
    }
    if (isBlank(t.maximumPercentage) && i !== tiers.length - 1) {
      errors.push(`Tier ${n}: only the last tier may have no maximum.`);
    }
  });
  if (errors.length) return errors;

  if (!D(tiers[0].minimumPercentage).eq(0)) {
    errors.push('The first tier must start at 0% so every result has a rate.');
  }
  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    const prevMax = D(prev.maximumPercentage);
    const curMin = D(cur.minimumPercentage);
    if (curMin.lte(D(prev.minimumPercentage))) {
      errors.push(`Tier ${i + 1} must start above tier ${i}.`);
    } else if (curMin.lte(prevMax)) {
      errors.push(`Tier ${i + 1} (${curMin}%) overlaps tier ${i} (up to ${prevMax}%).`);
    } else if (curMin.minus(prevMax).gt(MAX_GAP)) {
      errors.push(`Gap between tier ${i} (up to ${prevMax}%) and tier ${i + 1} (from ${curMin}%).`);
    }
  }
  return errors;
}

// Highest tier whose minimum is ≤ the percentage. Maxima are display boundaries,
// so 79.995% stays in "0 – 79.99" and exactly 80% moves to "80 – 86.99".
export function selectTier(tiers, percentage) {
  const pct = D(percentage);
  let chosen = null;
  tiers.forEach((t, index) => {
    if (pct.gte(D(t.minimumPercentage))) chosen = { ...t, index };
  });
  return chosen;
}

export const tierLabel = (t) =>
  isBlank(t.maximumPercentage)
    ? `${D(t.minimumPercentage)}%+`
    : `${D(t.minimumPercentage)}% – ${D(t.maximumPercentage)}%`;
