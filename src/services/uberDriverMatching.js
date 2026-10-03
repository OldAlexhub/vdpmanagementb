const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'services', 'service', 'transportation', 'transport', 'transit',
]);

export function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const tokensOf = (value) => normalizeName(value).split(' ').filter(Boolean);
const sortedName = (value) => tokensOf(value).sort().join(' ');
const withoutLegalSuffixes = (value) => tokensOf(value).filter((token) => !LEGAL_SUFFIXES.has(token)).join(' ');

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function nameSimilarity(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (sortedName(a) === sortedName(b)) return 0.99;
  const edit = 1 - (levenshtein(a, b) / Math.max(a.length, b.length));
  const at = new Set(tokensOf(a));
  const bt = new Set(tokensOf(b));
  const shared = [...at].filter((token) => bt.has(token)).length;
  const union = new Set([...at, ...bt]).size;
  const tokenScore = union ? shared / union : 0;
  return (edit * 0.65) + (tokenScore * 0.35);
}

export function suggestOperator(sourceName, candidates) {
  if (!normalizeName(sourceName)) return { suggestion: null, candidates: [] };
  const ranked = candidates.map((candidate) => {
    const names = [candidate.operatorName, candidate.providerName, withoutLegalSuffixes(candidate.providerName)].filter(Boolean);
    const score = Math.max(...names.map((name) => nameSimilarity(sourceName, name)));
    return { ...candidate, score };
  }).sort((a, b) => b.score - a.score || a.operatorName.localeCompare(b.operatorName));

  const [best, second] = ranked;
  const uniqueEnough = best && best.score >= 0.86 && (!second || best.score - second.score >= 0.08);
  return {
    suggestion: uniqueEnough ? {
      ...best,
      confidence: Number(best.score.toFixed(3)),
      reason: best.score >= 0.99 ? 'Name matches the operator profile' : 'Strong name match to the operator profile',
    } : null,
    candidates: ranked.filter((candidate) => candidate.score >= 0.55).slice(0, 3).map((candidate) => ({
      ...candidate,
      confidence: Number(candidate.score.toFixed(3)),
    })),
  };
}
