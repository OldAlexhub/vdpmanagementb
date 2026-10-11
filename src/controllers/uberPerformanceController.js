import * as service from '../services/uberPerformanceService.js';

export async function list(req, res) {
  res.json(await service.listUberImports({ cycleId: req.query.cycleId, divisionId: req.query.divisionId }));
}

export async function upload(req, res) {
  const results = await service.uploadUberFiles({
    cycleId: req.body.cycleId,
    divisionId: req.body.divisionId,
    files: req.files,
    user: req.user,
  });
  res.status(201).json({ files: results, cycleId: results.find((result) => result.cycleId)?.cycleId || null });
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
