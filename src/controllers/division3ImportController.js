import * as service from '../services/division3ImportService.js';
import fs from 'node:fs/promises';

async function removeTemporaryUploads(files = []) {
  await Promise.allSettled(files.filter((file) => file.path).map((file) => fs.unlink(file.path)));
}

export async function list(req, res) {
  res.json(await service.listDivision3Imports({ cycleId: req.query.cycleId, divisionId: req.query.divisionId, kind: req.query.kind }));
}

export async function upload(req, res) {
  try {
    const results = await service.uploadDivision3Files({
      cycleId: req.body.cycleId,
      divisionId: req.body.divisionId,
      kind: req.body.kind,
      files: req.files,
      user: req.user,
    });
    res.status(201).json({ files: results, cycleId: results.find((result) => result.cycleId)?.cycleId || null });
  } finally {
    await removeTemporaryUploads(req.files);
  }
}

export async function remove(req, res) {
  res.json(await service.removeDivision3Import(req.params.id, req.user));
}

export async function clearInvalid(req, res) {
  res.json(await service.clearInvalidDivision3Imports({ cycleId: req.query.cycleId, kind: req.query.kind }));
}

export async function assignDriver(req, res) {
  const provider = await service.assignDivision3Driver(req.body, req.user);
  res.json({ providerId: provider._id, name: provider.name });
}

export async function clearDriverMatch(req, res) {
  res.json(await service.clearDivision3DriverMatch(req.body));
}

export async function setAsideDriver(req, res) {
  res.json(await service.setAsideDivision3Driver(req.body, req.user));
}

export async function restoreDriver(req, res) {
  res.json(await service.restoreDivision3Driver(req.body, req.user));
}
