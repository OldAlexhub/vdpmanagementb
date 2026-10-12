import * as service from '../services/processingRunService.js';

export async function list(req, res) {
  res.json(await service.listRuns({ status: req.query.status, limit: req.query.limit }));
}

export async function open(req, res) {
  res.status(201).json(await service.openRun({ cycleId: req.body.cycleId, user: req.user }));
}

export async function get(req, res) {
  res.json(await service.getRun(req.params.id, req.user));
}

export async function process(req, res) {
  res.json(await service.processReady(req.params.id, req.user));
}

export async function archive(req, res) {
  res.json(await service.archiveRun(req.params.id, req.body.reason, req.user));
}
