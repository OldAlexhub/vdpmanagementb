// Route identifiers are entered by people and also arrive from external reports. Match harmless
// formatting differences automatically, while keeping different numeric routes and conflicting
// lettered variants separate.

export function routeKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const numericRoute = (value) => {
  const match = /^(\d+)([A-Z]?)$/.exec(routeKey(value));
  return match ? { number: match[1], suffix: match[2] } : null;
};

/**
 * Higher scores are safer and always win over lower-scored candidates.
 * 4: the stored text is identical
 * 3: only case, whitespace or punctuation differs
 * 2: the numeric route is the same and exactly one side has one trailing letter
 * 1: the numeric route is the same and the one-letter suffix differs
 */
export function routeMatchScore(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  if (!a || !b) return 0;
  if (a === b) return 4;

  const aKey = routeKey(a);
  const bKey = routeKey(b);
  if (!aKey || !bKey) return 0;
  if (aKey === bKey) return 3;

  const aRoute = numericRoute(aKey);
  const bRoute = numericRoute(bKey);
  if (!aRoute || !bRoute || aRoute.number !== bRoute.number) return 0;
  if (Boolean(aRoute.suffix) !== Boolean(bRoute.suffix)) return 2;
  return aRoute.suffix && bRoute.suffix ? 1 : 0;
}

export function routeMatchType(score) {
  if (score === 4) return 'EXACT';
  if (score === 3) return 'NORMALIZED';
  if (score === 2) return 'BASE_ROUTE';
  if (score === 1) return 'ROUTE_NUMBER';
  return null;
}

/** Return only the configured routes at the best available score. */
export function bestRouteMatches(reportRoute, configuredRoutes = []) {
  const ranked = configuredRoutes
    .map((route) => ({ route, score: routeMatchScore(reportRoute, route) }))
    .filter((match) => match.score > 0);
  if (!ranked.length) return { score: 0, matchType: null, routes: [] };
  const score = Math.max(...ranked.map((match) => match.score));
  return {
    score,
    matchType: routeMatchType(score),
    routes: ranked.filter((match) => match.score === score).map((match) => match.route),
  };
}
