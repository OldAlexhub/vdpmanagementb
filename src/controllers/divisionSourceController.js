import * as service from '../services/divisionSourceService.js';
import fs from 'node:fs/promises';

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
  try {
    const result = await service.uploadDivisionSourceFiles({
      cycleId: req.body.cycleId,
      divisionId: req.body.divisionId,
      datasetType: req.body.datasetType,
      files: req.files,
      supersedesId: req.body.supersedesId,
      user: req.user,
    });
    res.status(201).json(result);
  } finally {
    await Promise.all((req.files || []).filter((file) => file.path).map((file) => fs.unlink(file.path).catch(() => {})));
  }
}

export async function remove(req, res) {
  res.json(await service.removeDivisionSourceImport(req.params.id, req.user));
}

