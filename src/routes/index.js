import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireAuth, requireAdmin, requireStaff, requireProvider, requireAccounting, requireNsm } from '../middleware/auth.js';
import { loginThrottle } from '../middleware/security.js';
import * as auth from '../controllers/authController.js';
import * as divisions from '../controllers/divisionController.js';
import * as plans from '../controllers/planController.js';
import * as providers from '../controllers/providerController.js';
import * as cycles from '../controllers/cycleController.js';
import * as processingGroups from '../controllers/processingGroupController.js';
import * as performance from '../controllers/performanceController.js';
import * as uberPerformance from '../controllers/uberPerformanceController.js';
import * as uberTolls from '../controllers/uberTollController.js';
import * as division3Imports from '../controllers/division3ImportController.js';
import * as divisionSources from '../controllers/divisionSourceController.js';
import * as vdps from '../controllers/vdpController.js';
import * as portal from '../controllers/portalController.js';
import * as imports from '../controllers/importController.js';
import * as compass from '../controllers/compassController.js';
import * as compassPerformance from '../controllers/compassPerformanceController.js';
import * as liftLeases from '../controllers/liftLeaseController.js';
import * as processingRuns from '../controllers/processingRunController.js';
import * as lifecycle from '../controllers/lifecycleController.js';
import { cycleWorkbook } from '../services/exportService.js';
import { registerPdf, cycleSchedulePdf, planReportPdf } from '../services/pdfService.js';
import { leadershipReport, providerReport } from '../services/analyticsService.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
// Large Compass duty exports are spooled outside MongoDB and processed one at
// a time. The controller removes each temporary file after normalization.
const division3Upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, os.tmpdir()),
    filename: (_req, file, done) => done(null, `bigstar-vdp-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 },
});
const api = Router();

api.get('/auth/status', auth.status);
api.post('/auth/setup', auth.setup);
api.post('/auth/login', loginThrottle, auth.login);
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

// Compass is the roster authority. MongoDB remains the VDP application database.
api.get('/compass/status', compass.status);
api.post('/compass/test', requireAdmin, compass.test);
api.post('/compass/preview', requireAdmin, compass.preview);
api.post('/compass/sync', requireAdmin, compass.sync);
api.put('/compass/settings', requireAdmin, compass.updateSettings);

api.get('/lift-leases', liftLeases.list);
api.post('/lift-leases/options', requireAdmin, liftLeases.createOption);
api.put('/lift-leases/options/:optionId', requireAdmin, liftLeases.updateOption);
api.put('/lift-leases/:divisionId', requireAdmin, liftLeases.update);

api.get('/divisions', divisions.list);
api.post('/divisions', requireAdmin, divisions.create);
api.get('/divisions/:id', divisions.get);
api.put('/divisions/:id', requireAdmin, divisions.update);
api.patch('/divisions/:id/status', requireAdmin, divisions.setStatus);

api.get('/vdp-plans', plans.list);
api.post('/vdp-plans', requireAdmin, plans.create);
api.get('/vdp-plan-templates', plans.templates);
api.get('/vdp-plans/:id', plans.get);
api.get('/vdp-plans/:id/report.pdf', async (req, res) => {
  const { buffer, fileName } = await planReportPdf(req.params.id);
  vdps.sendPdf(res, buffer, fileName);
});
api.put('/vdp-plans/:id', requireAdmin, plans.update);
api.post('/vdp-plans/:id/validate-and-activate', requireAdmin, plans.validateAndActivate);
api.post('/vdp-plans/:id/versions', requireAdmin, plans.addVersion);
api.put('/vdp-plans/:id/versions/:versionId', requireAdmin, plans.updateVersion);
// Fuel schedules are versioned configuration and remain Admin-controlled.
api.put('/vdp-plans/:id/fuel-prices', requireAdmin, plans.setFuelPrices);

api.get('/providers', providers.list);
api.post('/providers', requireAdmin, providers.create);
api.put('/providers/division/:divisionId/plan', requireAdmin, providers.assignDivisionPlan);
api.post('/providers/plans/unassign', requireAdmin, providers.batchUnassignPlans);
api.get('/providers/:id', providers.get);
api.put('/providers/:id', requireAdmin, providers.update);
api.post('/providers/:id/operators/:operatorId/transfer', requireAdmin, providers.transferOperator);

// Bulk import from Excel: divisions | plans | providers. Admin-only kinds are checked in the controller.
api.get('/imports/:kind/template', imports.template);
api.post('/imports/:kind/preview', upload.single('file'), imports.preview);
api.post('/imports/:kind/commit', upload.single('file'), imports.commit);

// VDP cycles are company-wide: one schedule, every period exists for every active division.
api.get('/settings/cycle-schedule', cycles.getSchedule);
api.put('/settings/cycle-schedule', requireAdmin, cycles.updateSchedule);
api.get('/settings/processing-groups', processingGroups.list);
api.put('/settings/processing-groups', requireAdmin, processingGroups.update);
api.get('/cycles', cycles.list);
api.get('/cycles/periods', cycles.periods);
api.post('/cycles/generate', requireAdmin, cycles.generate);
api.get('/cycles/preview', cycles.preview);
api.get('/cycles/:id', cycles.get);
api.get('/cycles/:cycleId/compass-performance', compassPerformance.get);
api.post('/cycles/:cycleId/compass-performance/sync', requireAccounting, compassPerformance.sync);
api.post('/cycles/:cycleId/compass-performance/corrections', requireAccounting, compassPerformance.correct);
api.patch('/cycles/:id', requireAccounting, cycles.update);

api.get('/processing-runs', processingRuns.list);
api.post('/processing-runs', requireAccounting, processingRuns.open);
api.get('/processing-runs/:id', processingRuns.get);
api.post('/processing-runs/:id/process', requireAccounting, processingRuns.process);
api.post('/processing-runs/:id/archive', requireAdmin, processingRuns.archive);

api.get('/performance-imports', performance.list);
api.post('/performance-imports', requireAccounting, upload.single('file'), performance.upload);
api.get('/performance-imports/:id', performance.get);
api.post('/performance-imports/:id/routes', requireAccounting, performance.resolve);

api.get('/uber-performance-imports', uberPerformance.list);
api.post('/uber-performance-imports', requireAccounting, upload.array('files', 20), uberPerformance.upload);
api.delete('/uber-performance-imports/invalid', requireAccounting, uberPerformance.clearInvalid);
api.delete('/uber-performance-imports/:id', requireAccounting, uberPerformance.remove);
api.post('/uber-driver-matches', requireAccounting, uberPerformance.assignDriver);

api.get('/division3-imports', division3Imports.list);
api.post('/division3-imports', division3Upload.array('files', 20), division3Imports.upload);
api.delete('/division3-imports/invalid', division3Imports.clearInvalid);
api.delete('/division3-imports/:id', division3Imports.remove);
api.post('/division3-driver-matches', requireNsm, division3Imports.assignDriver);
api.post('/division3-driver-matches/clear', requireNsm, division3Imports.clearDriverMatch);
api.post('/division3-driver-exclusions', requireNsm, division3Imports.setAsideDriver);
api.post('/division3-driver-exclusions/restore', requireNsm, division3Imports.restoreDriver);

api.get('/division-source-contracts/:divisionId', divisionSources.contract);
api.get('/division-source-imports', divisionSources.list);
api.post('/division-source-imports', requireAccounting, division3Upload.array('files', 100), divisionSources.upload);
api.delete('/division-source-imports/:id', requireAccounting, divisionSources.remove);

api.get('/uber-toll-imports', uberTolls.list);
api.post('/uber-toll-imports', requireAccounting, upload.array('files', 20), uberTolls.upload);
api.delete('/uber-toll-imports/invalid', requireAccounting, uberTolls.clearInvalid);
api.delete('/uber-toll-imports/:id', requireAccounting, uberTolls.remove);

api.get('/vdps', vdps.list);
api.get('/vdps/adjustment-types', vdps.adjustmentTypes);
api.post('/vdps/process', requireAccounting, vdps.process);
api.post('/vdps/bulk-approve', requireAccounting, vdps.bulkApprove);
api.get('/vdps/:id', vdps.get);
api.get('/vdps/:id/statement.pdf', vdps.statement);
api.post('/vdps/:id/recalculate', requireAccounting, vdps.recalculate);
api.post('/vdps/:id/adjustments', requireAccounting, vdps.addAdjustment);
api.delete('/vdps/:id/adjustments/:adjustmentId', requireAccounting, vdps.removeAdjustment);
api.patch('/vdps/:id/lease', requireAccounting, vdps.setLease);
api.patch('/vdps/:id/fuel-expense', requireAccounting, vdps.setFuelExpense);
api.put('/vdps/:id/uber-weekly-adjustment', requireAccounting, vdps.setUberWeeklyAdjustment);
api.post('/vdps/:id/acknowledge', requireAccounting, vdps.acknowledge);
api.post('/vdps/:id/approve', requireAccounting, vdps.approve);
api.post('/vdps/:id/reopen', requireAccounting, vdps.reopen);
api.post('/vdps/:id/mark-paid', requireAccounting, vdps.markPaid);
api.post('/vdps/:id/issues/respond', requireNsm, vdps.respondToIssue);

api.get('/records/:type/:id/dependencies', requireAdmin, lifecycle.dependencies);
api.post('/records/:type/:id/archive', requireAdmin, lifecycle.archive);
api.post('/records/:type/:id/purge', requireAdmin, lifecycle.purge);

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
