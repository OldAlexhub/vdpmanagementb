import PerformanceImport from '../models/PerformanceImport.js';
import Provider from '../models/Provider.js';
import { importReport, resolveRoute, matchRoutes } from '../services/performanceService.js';
import { notFound } from '../services/errors.js';

const summary = (d) => {
  const { rows, ...rest } = d.toJSON();
  return { ...rest, routeCount: new Set(rows.map((r) => r.route)).size };
};

export async function list(req, res) {
  const filter = {};
  if (req.query.cycleId) filter.cycleId = req.query.cycleId;
  if (req.query.divisionId) filter.divisionId = req.query.divisionId;
  const docs = await PerformanceImport.find(filter).sort({ uploadedAt: -1 });
  res.json(docs.map(summary));
}

export async function get(req, res) {
  const doc = await PerformanceImport.findById(req.params.id);
  if (!doc) throw notFound('Performance import');
  const providers = await Provider.find({ divisionId: doc.divisionId });
  res.json({ ...doc.toJSON(), routeMatches: matchRoutes(doc, providers) });
}

export async function upload(req, res) {
  const doc = await importReport({
    cycleId: req.body.cycleId,
    file: req.file,
    replace: req.body.replace === 'true' || req.body.replace === true,
    replaceReason: req.body.replaceReason,
    user: req.user,
  });
  res.status(201).json(summary(doc));
}

export async function resolve(req, res) {
  const doc = await resolveRoute(req.params.id, req.body, req.user);
  const providers = await Provider.find({ divisionId: doc.divisionId });
  res.json({ routeMatches: matchRoutes(doc, providers) });
}
