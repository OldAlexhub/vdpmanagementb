import * as service from '../services/divisionSourceService.js';

export async function contract(req, res) {
  res.json(await service.contractForDivisionId(req.params.divisionId));
}

export async function list(req, res) {
  res.json(await service.listDivisionSourceImports({
    cycleId: req.query.cycleId,
    divisionId: req.query.divisionId,
    datasetType: req.query.datasetType,
  }));
}

export async function upload(req, res) {
  const result = await service.uploadDivisionSourceFiles({
    cycleId: req.body.cycleId,
    divisionId: req.body.divisionId,
    datasetType: req.body.datasetType,
    files: req.files,
    user: req.user,
  });
  res.status(201).json(result);
}

export async function remove(req, res) {
  res.json(await service.removeDivisionSourceImport(req.params.id, req.user));
}

