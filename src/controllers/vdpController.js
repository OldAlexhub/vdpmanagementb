import Vdp from '../models/Vdp.js';
import Provider from '../models/Provider.js';
import * as svc from '../services/vdpService.js';
import { ADJUSTMENT_TYPES } from '../services/calculationEngine.js';
import { notFound, badRequest } from '../services/errors.js';
import { statementPdf, statementFileName } from '../services/pdfService.js';

export async function list(req, res) {
  await svc.autoApproveDue();
  const filter = {};
  for (const k of ['cycleId', 'divisionId', 'status', 'providerId']) if (req.query[k]) filter[k] = req.query[k];
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const ids = await Provider.find({ $or: [{ name: rx }, { operatorName: rx }, { routes: rx }, { providerNumber: rx }] }, '_id');
    filter.providerId = { $in: ids.map((p) => p._id) };
  }
  const vdps = await Vdp.find(filter, '-history -performance.days -snapshot.performance.days')
    .populate('providerId', 'name operatorName routes providerNumber')
    .populate('cycleId', 'cycleStart cycleEnd paymentDate submissionDate')
    .sort({ status: 1 });
  res.json(vdps.map((v) => {
    const j = v.toJSON();
    const src = v.snapshot || {};
    return {
      _id: v._id,
      status: v.status,
      stale: v.stale,
      provider: src.provider || (v.providerId && {
        id: v.providerId._id, name: v.providerId.name, operatorName: v.providerId.operatorName,
        routes: v.providerId.routes, providerNumber: v.providerId.providerNumber,
      }),
      planName: src.plan?.name || v.settings?.planName || null,
      gross: j.gross,
      net: j.net,
      totalDeductions: v.calculation?.totalDeductions ?? null,
      totalAdditions: v.calculation?.totalAdditions ?? null,
      weeks: ((src.calculation || v.calculation)?.weeks || []).map((w) => ({
        weekNumber: w.weekNumber,
        trips: w.trips,
        actualHours: w.actualHours,
        weeklyEarnings: w.weeklyEarnings,
      })),
      exceptions: v.exceptions,
      providerDeadline: v.providerDeadline,
      providerApproval: v.providerApproval?.method ? { method: v.providerApproval.method, at: v.providerApproval.at } : null,
      cycleId: v.cycleId?._id,
      cycle: v.cycleId && {
        cycleStart: v.cycleId.cycleStart, cycleEnd: v.cycleId.cycleEnd,
        paymentDate: v.cycleId.paymentDate, submissionDate: v.cycleId.submissionDate,
      },
      divisionId: v.divisionId,
    };
  }).sort((a, b) => (a.provider?.name || '').localeCompare(b.provider?.name || '')));
}

export async function get(req, res) {
  await svc.autoApproveDue();
  const vdp = await Vdp.findById(req.params.id);
  if (!vdp) throw notFound('VDP');
  res.json(await svc.vdpView(vdp));
}

const respond = async (res, vdp) => res.json(await svc.vdpView(vdp));

export async function process(req, res) {
  if (!req.body.cycleId) throw badRequest('Choose a VDP cycle.');
  res.json(await svc.processCycle(req.body.cycleId, req.user));
}

export const recalculate = async (req, res) => respond(res, await svc.recalculate(req.params.id, req.user));
export const addAdjustment = async (req, res) => respond(res, await svc.addAdjustment(req.params.id, req.body, req.user));
export const removeAdjustment = async (req, res) =>
  respond(res, await svc.removeAdjustment(req.params.id, req.params.adjustmentId, req.user));
export const setLease = async (req, res) => respond(res, await svc.setLeaseWeeks(req.params.id, req.body, req.user));
export const setFuelExpense = async (req, res) => respond(res, await svc.setFuelExpense(req.params.id, req.body, req.user));
export const setUberWeeklyAdjustment = async (req, res) => respond(res, await svc.setUberWeeklyAdjustment(req.params.id, req.body, req.user));
export const acknowledge = async (req, res) => respond(res, await svc.acknowledge(req.params.id, req.body, req.user));
export const approve = async (req, res) => respond(res, await svc.approve(req.params.id, req.user));
export const reopen = async (req, res) => respond(res, await svc.reopen(req.params.id, req.body, req.user));
export const markPaid = async (req, res) => respond(res, await svc.markPaid(req.params.id, req.user));
export async function statement(req, res) {
  await svc.autoApproveDue();
  const vdp = await Vdp.findById(req.params.id);
  if (!vdp) throw notFound('VDP');
  const view = await svc.vdpView(vdp);
  sendPdf(res, await statementPdf(view), statementFileName(view));
}

export function sendPdf(res, buffer, fileName) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
  res.send(buffer);
}

export const respondToIssue = async (req, res) => respond(res, await svc.respondToIssue(req.params.id, req.body, req.user));

export const adjustmentTypes = (_req, res) =>
  res.json(Object.entries(ADJUSTMENT_TYPES).map(([key, v]) => ({ key, label: v.label, direction: v.direction })));
