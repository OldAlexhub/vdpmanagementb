import { compassPerformanceView, syncCompassPerformance, correctCompassPerformance } from '../services/compassPerformanceService.js';

export const get = async (req, res) => res.json(await compassPerformanceView(req.params.cycleId));
export const sync = async (req, res) => res.json(await syncCompassPerformance(req.params.cycleId, { expectedRevision: req.body.expectedRevision, user: req.user }));
export const correct = async (req, res) => res.json(await correctCompassPerformance(req.params.cycleId, req.body, req.user));
