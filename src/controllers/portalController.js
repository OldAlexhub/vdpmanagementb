// Provider portal: a provider sees only their own VDPs, only after Big Star has approved them,
// and only the frozen statement (never internal notes, files or staff audit details).
import Vdp, { ISSUE_AREAS } from '../models/Vdp.js';
import Provider from '../models/Provider.js';
import { providerApprove, raiseIssue as raise, autoApproveDue } from '../services/vdpService.js';
import { notFound } from '../services/errors.js';
import { statementPdf, statementFileName } from '../services/pdfService.js';
import { sendPdf } from './vdpController.js';

const REVIEWABLE = ['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'];
// Also visible: a statement Big Star reopened to correct the provider's issue.
const visibleFilter = (providerId) => ({
  providerId,
  $or: [{ status: { $in: REVIEWABLE } }, { 'issues.status': 'IN_CORRECTION' }],
});

// Staff names are never shown to providers.
const portalIssues = (vdp) => vdp.issues.map((i) => ({
  _id: i._id,
  items: i.items.map((it) => ({ ...it.toObject(), areaLabel: ISSUE_AREAS[it.area] })),
  comment: i.comment,
  status: i.status,
  raisedAt: i.raisedAt,
  raisedBy: { name: i.raisedBy?.name },
  netAtRaise: i.netAtRaise,
  response: i.response?.action && i.status === 'RESOLVED'
    ? { action: i.response.action, message: i.response.message, at: i.response.at, newNet: i.response.newNet, by: { name: 'Big Star' } }
    : null,
}));

const portalStatus = (vdp) => (REVIEWABLE.includes(vdp.status) ? vdp.status : 'IN_CORRECTION');

function portalView(vdp) {
  const s = vdp.snapshot;
  return {
    _id: vdp._id,
    status: portalStatus(vdp),
    providerDeadline: vdp.providerDeadline,
    providerApproval: vdp.providerApproval?.method
      ? { method: vdp.providerApproval.method, at: vdp.providerApproval.at, by: { name: vdp.providerApproval.by?.name } }
      : null,
    paidAt: vdp.paidAt,
    issues: portalIssues(vdp),
    view: s && {
      source: 'SNAPSHOT',
      provider: s.provider,
      division: s.division,
      cycle: s.cycle,
      plan: s.plan && { name: s.plan.name, versionNumber: s.plan.versionNumber },
      settings: s.settings,
      performance: s.performance,
      lease: s.lease && { amount: s.lease.amount, frequency: s.lease.frequency, weeksCharged: s.lease.weeksCharged },
      adjustments: (s.adjustments || []).map((a) => ({ type: a.type, amount: a.amount, description: a.description, date: a.date })),
      calculation: s.calculation,
      gross: s.gross,
      net: s.net,
      approvedAt: s.approvedAt,
    },
  };
}

export async function me(req, res) {
  const p = await Provider.findById(req.user.providerId, 'name providerNumber operatorName routes');
  res.json(p);
}

export async function list(req, res) {
  await autoApproveDue();
  const vdps = await Vdp.find(visibleFilter(req.user.providerId), 'status providerDeadline providerApproval paidAt gross net cycleId issues snapshot.net')
    .populate('cycleId', 'cycleStart cycleEnd paymentDate submissionDate');
  res.json(vdps
    .map((v) => ({
      _id: v._id,
      status: portalStatus(v),
      providerDeadline: v.providerDeadline,
      providerApproval: v.providerApproval?.method ? { method: v.providerApproval.method, at: v.providerApproval.at } : null,
      paidAt: v.paidAt,
      gross: v.snapshot ? v.gross?.toString() ?? null : null,
      net: v.snapshot ? v.net?.toString() ?? null : null,
      openIssue: v.issues.some((i) => i.status !== 'RESOLVED'),
      cycle: v.cycleId && {
        cycleStart: v.cycleId.cycleStart, cycleEnd: v.cycleId.cycleEnd,
        paymentDate: v.cycleId.paymentDate, submissionDate: v.cycleId.submissionDate,
      },
    }))
    .sort((a, b) => new Date(b.cycle?.cycleStart) - new Date(a.cycle?.cycleStart)));
}

export async function get(req, res) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: req.params.id, ...visibleFilter(req.user.providerId) });
  if (!vdp) throw notFound('VDP');
  res.json(portalView(vdp));
}

export async function approve(req, res) {
  const vdp = await providerApprove(req.params.id, req.user);
  res.json(portalView(vdp));
}

export async function raiseIssue(req, res) {
  const vdp = await raise(req.params.id, req.body, req.user);
  res.json(portalView(vdp));
}

export async function statement(req, res) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: req.params.id, ...visibleFilter(req.user.providerId) });
  if (!vdp || !vdp.snapshot) throw notFound('VDP statement');
  const view = portalView(vdp);
  sendPdf(res, await statementPdf(view), statementFileName(view));
}

export const issueAreas = (_req, res) => res.json(Object.entries(ISSUE_AREAS).map(([key, label]) => ({ key, label })));
