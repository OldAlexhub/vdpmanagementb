export function compassFixture({ dates = ['2026-09-01'], division = 'external-6', hours = 8, split = false } = {}) {
  const entries = dates.map((date) => ({
    _id: `entry-${date}`, division, date, source: split ? 'spare' : 'vision', route: { code: '600' },
    metrics: { completedTrips: 10, reportedServiceHours: hours, reportedRevenueHours: 6 },
    components: split ? [
      { sourceRow: 1, completedTrips: 4, reportedServiceHours: hours / 2, reportedRevenueHours: 3 },
      { sourceRow: 2, completedTrips: 6, reportedServiceHours: hours / 2, reportedRevenueHours: 3 },
    ] : [],
  }));
  const records = entries.flatMap((e) => (split ? e.components : [e.metrics]).map((m, i) => ({
    id: e._id, componentKey: split ? String(i + 1) : null, divisionId: division, date: e.date,
    route: '600', source: e.source, trips: m.completedTrips,
    operatorId: split ? `external-op-${i + 1}` : 'external-op-1', providerId: null, assignmentSource: 'dated_deployment',
  })));
  return { entries, analysis: {
    records,
    summary: { trips: dates.length * 10, serviceHours: dates.length * hours, revenueHours: dates.length * 6 },
    daily: dates.map((date) => ({ date, trips: 10, serviceHours: hours, revenueHours: 6 })),
  } };
}

export const fixtureRequest = (fixture) => async (name, query) => name === 'performance'
  ? fixture.analysis
  : { entries: fixture.entries.filter((entry) => entry.date === query.from && entry.source === query.source) };
