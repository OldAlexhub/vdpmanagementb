import * as service from '../services/uberPerformanceService.js';
import { badRequest } from '../services/errors.js';

export async function list(req, res) {
  res.json(await service.listUberImports({ cycleId: req.query.cycleId, divisionId: req.query.divisionId }));
}

export async function upload(req, res) {
  if (!req.body.cycleId) throw badRequest('Choose a VDP cycle.');
  const results = await service.uploadUberFiles({ cycleId: req.body.cycleId, files: req.files, user: req.user });
  res.status(201).json({ files: results });
}

export async function remove(req, res) {
  res.json(await service.removeUberImport(req.params.id, req.user));
}

export async function clearInvalid(req, res) {
  res.json(await service.clearInvalidUberImports({ cycleId: req.query.cycleId }));
}

export async function assignDriver(req, res) {
  const provider = await service.assignUberDriver(req.body, req.user);
  res.json({ providerId: provider._id, name: provider.name });
}
