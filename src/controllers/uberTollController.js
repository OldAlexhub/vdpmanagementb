import * as service from '../services/uberTollService.js';

export async function list(req, res) {
  res.json(await service.listUberTollImports({ cycleId: req.query.cycleId, divisionId: req.query.divisionId }));
}

export async function upload(req, res) {
  const results = await service.uploadUberTollFiles({
    cycleId: req.body.cycleId,
    divisionId: req.body.divisionId,
    files: req.files,
    user: req.user,
  });
  res.status(201).json({ files: results, cycleId: results.find((result) => result.cycleId)?.cycleId || null });
}

export async function remove(req, res) {
  res.json(await service.removeUberTollImport(req.params.id, req.user));
}

export async function clearInvalid(req, res) {
  res.json(await service.clearInvalidUberTollImports({ cycleId: req.query.cycleId }));
}

