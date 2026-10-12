import Division from '../models/Division.js';
import LiftLeaseOption from '../models/LiftLeaseOption.js';
import PerformanceImport from '../models/PerformanceImport.js';
import ProcessingRun from '../models/ProcessingRun.js';
import Provider from '../models/Provider.js';
import User from '../models/User.js';
import Vdp from '../models/Vdp.js';
import VdpCycle from '../models/VdpCycle.js';
import VdpPlan from '../models/VdpPlan.js';
import { badRequest, conflict, notFound } from './errors.js';
import { recordAudit } from './auditService.js';

const types = {
  division: { model: Division, label: 'Division', archive: (record) => { record.status = 'INACTIVE'; } },
  provider: { model: Provider, label: 'Provider', archive: (record) => { record.status = 'INACTIVE'; } },
  plan: { model: VdpPlan, label: 'VDP plan', archive: (record) => { record.status = 'INACTIVE'; } },
  cycle: { model: VdpCycle, label: 'VDP cycle', archive: (record) => { record.status = 'ARCHIVED'; } },
  'lift-lease': { model: LiftLeaseOption, label: 'Lift lease option', archive: (record) => { record.status = 'INACTIVE'; } },
  import: { model: PerformanceImport, label: 'Dataset import', archive: (record) => { record.status = 'REPLACED'; record.replaceReason = 'Archived by an administrator'; } },
};

function typeInfo(type) {
  const info = types[type];
  if (!info) throw badRequest('Unsupported record type.');
  return info;
}

export async function dependencies(type, id) {
  typeInfo(type);
  if (type === 'plan') return {
    providers: await Provider.countDocuments({ $or: [{ planId: id }, { 'operators.planId': id }] }),
    vdps: await Vdp.countDocuments({ planId: id }),
  };
  if (type === 'provider') return {
    vdps: await Vdp.countDocuments({ providerId: id }),
    users: await User.countDocuments({ providerId: id }),
  };
  if (type === 'division') return {
    providers: await Provider.countDocuments({ divisionId: id }),
    plans: await VdpPlan.countDocuments({ divisionId: id }),
    cycles: await VdpCycle.countDocuments({ divisionId: id }),
    imports: await PerformanceImport.countDocuments({ divisionId: id }),
    liftLeases: await LiftLeaseOption.countDocuments({ divisionId: id }),
  };
  if (type === 'cycle') return {
    vdps: await Vdp.countDocuments({ cycleId: id }),
    imports: await PerformanceImport.countDocuments({ cycleId: id }),
    processingRuns: await ProcessingRun.countDocuments({ cycleId: id }),
  };
  if (type === 'lift-lease') return {
    operators: await Provider.countDocuments({ 'operators.liftLease.optionId': id }),
  };
  if (type === 'import') return {
    vdps: await Vdp.countDocuments({
      $or: [
        { performanceImportId: id },
        { uberPerformanceImportIds: id },
        { division3ImportIds: id },
      ],
    }),
  };
  return {};
}

const totalDependencies = (value) => Object.values(value).reduce((sum, item) => sum + Number(item || 0), 0);

export async function archive(type, id, reason, user) {
  if (!String(reason || '').trim()) throw badRequest('Give a reason for archiving this record.');
  const info = typeInfo(type);
  const record = await info.model.findById(id);
  if (!record) throw notFound(info.label);
  const before = record.toJSON();
  info.archive(record);
  await record.save();
  await recordAudit({ action: 'ARCHIVE', entityType: info.label, entityId: record._id, entityLabel: record.name || record.divisionNumber, reason, user, before, after: record.toJSON() });
  return { record, dependencies: await dependencies(type, id) };
}

export async function purge(type, id, reason, confirmation, user) {
  if (!String(reason || '').trim()) throw badRequest('Give a reason for permanently deleting this record.');
  if (confirmation !== 'PURGE') throw badRequest('Type PURGE to confirm permanent deletion.');
  const info = typeInfo(type);
  const record = await info.model.findById(id);
  if (!record) throw notFound(info.label);
  if (type === 'plan' && record.status !== 'DRAFT') {
    throw conflict('Only an unused draft plan can be permanently deleted. Archive active or inactive plans instead.');
  }
  const refs = await dependencies(type, id);
  if (totalDependencies(refs) > 0) {
    throw conflict('This record is referenced and cannot be permanently deleted. Archive it instead.', { dependencies: refs });
  }
  const before = record.toJSON();
  await record.deleteOne();
  await recordAudit({ action: 'PURGE', entityType: info.label, entityId: record._id, entityLabel: record.name || record.divisionNumber, reason, user, before, metadata: { dependencies: refs } });
  return { deleted: true, id: String(id), dependencies: refs };
}
