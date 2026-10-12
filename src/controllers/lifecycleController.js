import * as service from '../services/lifecycleService.js';

export async function dependencies(req, res) {
  res.json(await service.dependencies(req.params.type, req.params.id));
}

export async function archive(req, res) {
  res.json(await service.archive(req.params.type, req.params.id, req.body.reason, req.user));
}

export async function purge(req, res) {
  res.json(await service.purge(req.params.type, req.params.id, req.body.reason, req.body.confirmation, req.user));
}
