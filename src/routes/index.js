import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin, requireStaff, requireProvider } from '../middleware/auth.js';
import * as auth from '../controllers/authController.js';
import * as divisions from '../controllers/divisionController.js';
import * as plans from '../controllers/planController.js';
import * as providers from '../controllers/providerController.js';
import * as cycles from '../controllers/cycleController.js';
import * as performance from '../controllers/performanceController.js';
import * as vdps from '../controllers/vdpController.js';
import * as portal from '../controllers/portalController.js';
import * as imports from '../controllers/importController.js';
import { cycleWorkbook } from '../services/exportService.js';
import { registerPdf, cycleSchedulePdf } from '../services/pdfService.js';
import { leadershipReport, providerReport } from '../services/analyticsService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true }));

api.get('/auth/status', auth.status);
api.post('/auth/setup', auth.setup);
api.post('/auth/login', auth.login);
api.post('/auth/logout', auth.logout);

api.use(requireAuth);
api.get('/auth/me', auth.me);
api.post('/auth/password', auth.changePassword);

// Provider portal — provider logins only, scoped to their own provider.
api.get('/portal/me', requireProvider, portal.me);
api.get('/portal/vdps', requireProvider, portal.list);
api.get('/portal/issue-areas', requireProvider, portal.issueAreas);
api.get('/portal/vdps/:id', requireProvider, portal.get);
api.post('/portal/vdps/:id/approve', requireProvider, portal.approve);
api.post('/portal/vdps/:id/issues', requireProvider, portal.raiseIssue);
api.get('/portal/vdps/:id/statement.pdf', requireProvider, portal.statement);
api.get('/portal/dashboard', requireProvider, async (req, res) => res.json(await providerReport(req.user.providerId)));

// Everything below is Big Star staff only.
api.use(requireStaff);

api.get('/users', requireAdmin, auth.listUsers);
api.post('/users', requireAdmin, auth.createUser);
api.patch('/users/:id', requireAdmin, auth.updateUser);

api.get('/divisions', divisions.list);
api.post('/divisions', requireAdmin, divisions.create);
api.get('/divisions/:id', divisions.get);
api.put('/divisions/:id', requireAdmin, divisions.update);
api.patch('/divisions/:id/status', requireAdmin, divisions.setStatus);

api.get('/vdp-plans', plans.list);
api.post('/vdp-plans', requireAdmin, plans.create);
api.get('/vdp-plans/:id', plans.get);
api.put('/vdp-plans/:id', requireAdmin, plans.update);
api.post('/vdp-plans/:id/versions', requireAdmin, plans.addVersion);
api.put('/vdp-plans/:id/versions/:versionId', requireAdmin, plans.updateVersion);

api.get('/providers', providers.list);
api.post('/providers', providers.create);
api.get('/providers/:id', providers.get);
api.put('/providers/:id', providers.update);
api.post('/providers/:id/operators/:operatorId/transfer', providers.transferOperator);

// Bulk import from Excel: divisions | plans | providers. Admin-only kinds are checked in the controller.
api.get('/imports/:kind/template', imports.template);
api.post('/imports/:kind/preview', upload.single('file'), imports.preview);
api.post('/imports/:kind/commit', upload.single('file'), imports.commit);

// VDP cycles are company-wide: one schedule, every period exists for every active division.
api.get('/settings/cycle-schedule', cycles.getSchedule);
api.put('/settings/cycle-schedule', requireAdmin, cycles.updateSchedule);
api.get('/cycles', cycles.list);
api.get('/cycles/periods', cycles.periods);
api.post('/cycles/generate', cycles.generate);
api.get('/cycles/preview', cycles.preview);
api.get('/cycles/:id', cycles.get);
api.patch('/cycles/:id', cycles.update);

api.get('/performance-imports', performance.list);
api.post('/performance-imports', upload.single('file'), performance.upload);
api.get('/performance-imports/:id', performance.get);
api.post('/performance-imports/:id/routes', performance.resolve);

api.get('/vdps', vdps.list);
api.get('/vdps/adjustment-types', vdps.adjustmentTypes);
api.post('/vdps/process', vdps.process);
api.get('/vdps/:id', vdps.get);
api.get('/vdps/:id/statement.pdf', vdps.statement);
api.post('/vdps/:id/recalculate', vdps.recalculate);
api.post('/vdps/:id/adjustments', vdps.addAdjustment);
api.delete('/vdps/:id/adjustments/:adjustmentId', vdps.removeAdjustment);
api.patch('/vdps/:id/lease', vdps.setLease);
api.patch('/vdps/:id/fuel-expense', vdps.setFuelExpense);
api.post('/vdps/:id/acknowledge', vdps.acknowledge);
api.post('/vdps/:id/approve', vdps.approve);
api.post('/vdps/:id/reopen', vdps.reopen);
api.post('/vdps/:id/mark-paid', vdps.markPaid);
api.post('/vdps/:id/issues/respond', vdps.respondToIssue);

api.get('/exports/cycle-schedule.pdf', async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : undefined;
  const { buffer, fileName } = await cycleSchedulePdf({ year, schedule: await cycles.cycleSchedule() });
  vdps.sendPdf(res, buffer, fileName);
});

api.get('/exports/cycles/:cycleId.xlsx', async (req, res) => {
  const { buffer, fileName } = await cycleWorkbook(req.params.cycleId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));
});

api.get('/reports/leadership', async (req, res) => {
  res.json(await leadershipReport({ divisionId: req.query.divisionId, cycles: req.query.cycles || 6 }));
});

api.get('/exports/cycles/:cycleId.pdf', async (req, res) => {
  const { buffer, fileName } = await registerPdf(req.params.cycleId);
  vdps.sendPdf(res, buffer, fileName);
});

export default api;
