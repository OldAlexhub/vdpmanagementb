import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import { getCompanySettings } from '../models/CompanySettings.js';
import { normalizeName } from './uberDriverMatching.js';
import { readCompassSnapshot } from './compassClient.js';
import { joinOpenPeriods } from '../controllers/cycleController.js';
import { markStale } from './vdpService.js';
import { badRequest } from './errors.js';

export const compassDivisionNumber = (code) => String(code || '').trim().replace(/^DIV[_\s-]*/i, '');
const id = (value) => (value === undefined || value === null ? '' : String(value));
const sorted = (values) => [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

export function normalizeCompassSnapshot(snapshot) {
  const providerById = new Map(snapshot.providers.map((provider) => [id(provider._id), provider]));
  const routesByOperator = new Map();
  const vehiclesByOperator = new Map();
  for (const runCut of snapshot.runCuts) {
    const operatorId = id(runCut.operator?._id);
    if (!operatorId || !runCut.route?.code || runCut.status !== 'active') continue;
    if (!routesByOperator.has(operatorId)) routesByOperator.set(operatorId, new Set());
    routesByOperator.get(operatorId).add(String(runCut.route.code).trim());
    if (runCut.vehicle?.code) {
      if (!vehiclesByOperator.has(operatorId)) vehiclesByOperator.set(operatorId, new Set());
      vehiclesByOperator.get(operatorId).add(String(runCut.vehicle.code).trim());
    }
  }

  const divisionById = new Map(snapshot.divisions.map((division) => [id(division._id), {
    externalId: id(division._id),
    divisionNumber: compassDivisionNumber(division.code),
    code: String(division.code || '').trim(),
    name: String(division.name || '').trim(),
    timezone: String(division.timezone || '').trim(),
    status: division.active === false ? 'INACTIVE' : 'ACTIVE',
    type: String(division.type || '').trim(),
    providers: [],
  }]));

  const providerInstances = new Map();
  for (const operator of snapshot.operators) {
    const divisionId = id(operator.division?._id);
    const providerId = id(operator.provider?._id);
    const operatorId = id(operator._id);
    if (!divisionId || !providerId || !divisionById.has(divisionId)) continue;
    const key = `${providerId}|${divisionId}`;
    if (!providerInstances.has(key)) {
      const reference = providerById.get(providerId);
      providerInstances.set(key, {
        externalId: providerId,
        divisionExternalId: divisionId,
        name: String(reference?.name || operator.provider?.name || '').trim(),
        status: reference?.active === false ? 'INACTIVE' : 'ACTIVE',
        operators: [],
      });
    }
    const routes = sorted([...(routesByOperator.get(operatorId) || [])]);
    const vehicleUnits = sorted([...(vehiclesByOperator.get(operatorId) || [])]);
    providerInstances.get(key).operators.push({
      externalId: operatorId,
      employeeId: String(operator.employeeId || '').trim() || null,
      name: String(operator.name || '').trim(),
      status: operator.active === false ? 'INACTIVE' : 'ACTIVE',
      routes,
      vehicleUnits,
      vehicleUnit: vehicleUnits.length === 1 ? vehicleUnits[0] : null,
      eligibilities: String(operator.eligibilities || '').trim() || null,
    });
  }

  for (const provider of providerInstances.values()) {
    provider.operators.sort((a, b) => a.name.localeCompare(b.name));
    divisionById.get(provider.divisionExternalId).providers.push(provider);
  }
  const divisions = [...divisionById.values()].sort((a, b) => a.divisionNumber.localeCompare(b.divisionNumber, undefined, { numeric: true }));
  for (const division of divisions) division.providers.sort((a, b) => a.name.localeCompare(b.name));

  const referencedProviders = new Set([...providerInstances.values()].map((provider) => provider.externalId));
  return {
    retrievedAt: snapshot.retrievedAt,
    divisions,
    providerDivisionRecords: providerInstances.size,
    providersWithoutOperators: snapshot.providers.filter((provider) => !referencedProviders.has(id(provider._id))).length,
    operatorsWithoutEmployeeId: snapshot.operators.filter((operator) => !String(operator.employeeId || '').trim()).length,
    activeOperatorsWithoutRoutes: snapshot.operators.filter((operator) => operator.active !== false && !(routesByOperator.get(id(operator._id))?.size)).length,
    unassignedRunCuts: snapshot.runCuts.filter((runCut) => !runCut.operator?._id).length,
  };
}

const mongoOperators = (provider) => provider.operators?.length ? provider.operators : [{ name: provider.operatorName || provider.name }];

export async function previewCompassRoster() {
  const normalized = normalizeCompassSnapshot(await readCompassSnapshot());
  const [mongoDivisions, mongoProviders] = await Promise.all([
    Division.find().lean(),
    Provider.find().lean(),
  ]);
  const mongoDivisionByNumber = new Map(mongoDivisions.map((division) => [String(division.divisionNumber).toLowerCase(), division]));
  let matchedProviders = 0;
  let matchedOperators = 0;
  const providerRows = [];

  const divisions = normalized.divisions.map((division) => {
    const mongoDivision = mongoDivisionByNumber.get(division.divisionNumber.toLowerCase());
    const inMongo = mongoDivision ? mongoProviders.filter((provider) => id(provider.divisionId) === id(mongoDivision._id)) : [];
    let divisionProviderMatches = 0;
    let divisionOperatorMatches = 0;
    for (const provider of division.providers) {
      const match = inMongo.find((candidate) => normalizeName(candidate.name) === normalizeName(provider.name));
      if (match) { matchedProviders += 1; divisionProviderMatches += 1; }
      const existingOperators = match ? mongoOperators(match) : [];
      const operatorMatches = provider.operators.filter((operator) => existingOperators.some((candidate) => normalizeName(candidate.name) === normalizeName(operator.name))).length;
      matchedOperators += operatorMatches;
      divisionOperatorMatches += operatorMatches;
      providerRows.push({
        divisionNumber: division.divisionNumber,
        providerName: provider.name,
        status: provider.status,
        operatorCount: provider.operators.length,
        activeOperatorCount: provider.operators.filter((operator) => operator.status === 'ACTIVE').length,
        operatorsWithRoutes: provider.operators.filter((operator) => operator.routes.length).length,
        mongoProviderMatched: Boolean(match),
        exactOperatorMatches: operatorMatches,
      });
    }
    return {
      divisionNumber: division.divisionNumber,
      code: division.code,
      name: division.name,
      timezone: division.timezone,
      status: division.status,
      mongoDivisionMatched: Boolean(mongoDivision),
      providerCount: division.providers.length,
      operatorCount: division.providers.reduce((sum, provider) => sum + provider.operators.length, 0),
      activeOperatorCount: division.providers.reduce((sum, provider) => sum + provider.operators.filter((operator) => operator.status === 'ACTIVE').length, 0),
      providersMatched: divisionProviderMatches,
      operatorsMatched: divisionOperatorMatches,
    };
  });

  const compassNumbers = new Set(normalized.divisions.map((division) => division.divisionNumber.toLowerCase()));
  const missingFromCompass = mongoDivisions.filter((division) => !compassNumbers.has(String(division.divisionNumber).toLowerCase()))
    .map((division) => `DIV ${division.divisionNumber} ${division.name}`);
  const missingFromMongo = normalized.divisions.filter((division) => !mongoDivisionByNumber.has(division.divisionNumber.toLowerCase()))
    .map((division) => `DIV ${division.divisionNumber} ${division.name}`);
  const warnings = [];
  if (missingFromCompass.length) warnings.push(`MongoDB divisions not returned by this Compass token: ${missingFromCompass.join(', ')}.`);
  if (missingFromMongo.length) warnings.push(`Compass divisions not yet present in MongoDB: ${missingFromMongo.join(', ')}.`);
  if (normalized.activeOperatorsWithoutRoutes) warnings.push(`${normalized.activeOperatorsWithoutRoutes} active Compass operators have no active Master Run Cut route.`);
  if (normalized.operatorsWithoutEmployeeId) warnings.push(`${normalized.operatorsWithoutEmployeeId} Compass operator record has no employee ID.`);
  if (normalized.providersWithoutOperators) warnings.push(`${normalized.providersWithoutOperators} Compass provider records cannot be assigned to a division because they have no operators.`);

  return {
    readOnly: true,
    retrievedAt: normalized.retrievedAt,
    summary: {
      compassDivisions: normalized.divisions.length,
      providerDivisionRecords: normalized.providerDivisionRecords,
      compassOperators: normalized.divisions.reduce((sum, division) => sum + division.providers.reduce((n, provider) => n + provider.operators.length, 0), 0),
      operatorsWithRoutes: normalized.divisions.reduce((sum, division) => sum + division.providers.reduce((n, provider) => n + provider.operators.filter((operator) => operator.routes.length).length, 0), 0),
      mongoDivisionMatches: divisions.filter((division) => division.mongoDivisionMatched).length,
      exactProviderMatches: matchedProviders,
      exactOperatorMatches: matchedOperators,
      unassignedRunCuts: normalized.unassignedRunCuts,
    },
    warnings,
    divisions,
    providers: providerRows,
  };
}

const sourceOf = (externalId, at) => ({ system: 'COMPASS', externalId, lastSyncedAt: at });
const rosterSignature = (provider) => JSON.stringify({
  divisionId: id(provider.divisionId),
  name: provider.name,
  status: provider.status,
  operators: (provider.operators || []).map((operator) => ({
    externalId: operator.source?.externalId || null,
    employeeId: operator.employeeId || null,
    name: operator.name,
    status: operator.status,
    routes: [...(operator.routes || [])].sort(),
    vehicleUnit: operator.vehicleUnit || null,
    liftLease: {
      amount: operator.liftLease?.amount === null || operator.liftLease?.amount === undefined ? null : String(operator.liftLease.amount),
      frequency: operator.liftLease?.frequency || 'NONE',
    },
  })),
});

export function assertSafeCompassSnapshot(normalized) {
  const operators = normalized.divisions.reduce((total, division) => total
    + division.providers.reduce((count, provider) => count + provider.operators.length, 0), 0);
  if (!normalized.divisions.length || !normalized.providerDivisionRecords || !operators) {
    throw badRequest('Compass returned an incomplete roster. MongoDB was not changed.', {
      code: 'COMPASS_INCOMPLETE_ROSTER',
      counts: { divisions: normalized.divisions.length, providers: normalized.providerDivisionRecords, operators },
    });
  }
  return normalized;
}

const plainOperator = (operator, { keepIdentity = true } = {}) => {
  const value = operator?.toObject ? operator.toObject() : { ...(operator || {}) };
  if (!keepIdentity) {
    delete value._id;
    delete value.startDate;
    delete value.endDate;
    delete value.transferredFrom;
    delete value.transferredTo;
  }
  return value;
};

function compassOperatorValue(operator, previous, syncedAt, { keepIdentity = true, divisionLease = null } = {}) {
  const value = plainOperator(previous, { keepIdentity });
  return {
    ...value,
    name: operator.name,
    routes: operator.routes,
    status: operator.status,
    vehicleUnit: operator.vehicleUnit,
    employeeId: operator.employeeId,
    source: sourceOf(operator.externalId, syncedAt),
    liftLease: divisionLease || value.liftLease || { amount: null, frequency: 'NONE' },
  };
}

async function performCompassSync(snapshot) {
  const normalized = assertSafeCompassSnapshot(normalizeCompassSnapshot(snapshot));
  const syncedAt = new Date();
  const [mongoDivisions, mongoProviders] = await Promise.all([Division.find(), Provider.find()]);
  const divisionByExternalId = new Map(mongoDivisions
    .filter((division) => division.source?.system === 'COMPASS' && division.source.externalId)
    .map((division) => [id(division.source.externalId), division]));
  const divisionByNumber = new Map(mongoDivisions.map((division) => [String(division.divisionNumber).toLowerCase(), division]));
  const globalOperatorByExternalId = new Map();
  for (const provider of mongoProviders) {
    for (const operator of provider.operators || []) {
      if (operator.source?.system === 'COMPASS' && operator.source.externalId) {
        globalOperatorByExternalId.set(id(operator.source.externalId), { operator, provider });
      }
    }
  }

  const summary = {
    divisions: { created: 0, adopted: 0, updated: 0 },
    providers: { created: 0, adopted: 0, updated: 0, deactivated: 0 },
    operators: { created: 0, adopted: 0, updated: 0, deactivated: 0 },
    staleProviders: 0,
    untouchedMongoDivisions: mongoDivisions.filter((division) => !normalized.divisions
      .some((source) => source.divisionNumber.toLowerCase() === String(division.divisionNumber).toLowerCase())).length,
    dataQuality: {
      providersWithoutOperators: normalized.providersWithoutOperators,
      activeOperatorsWithoutRoutes: normalized.activeOperatorsWithoutRoutes,
      operatorsWithoutEmployeeId: normalized.operatorsWithoutEmployeeId,
      unassignedRunCuts: normalized.unassignedRunCuts,
    },
  };
  const changedProviderIds = new Set();
  const managedDivisionIds = new Set();
  const desiredProviderKeys = new Set();

  for (const compassDivision of normalized.divisions) {
    let division = divisionByExternalId.get(compassDivision.externalId)
      || divisionByNumber.get(compassDivision.divisionNumber.toLowerCase());
    const isNew = !division;
    const wasCompass = division?.source?.system === 'COMPASS';
    if (!division) division = new Division({ divisionNumber: compassDivision.divisionNumber, name: compassDivision.name });
    division.divisionNumber = compassDivision.divisionNumber;
    division.name = compassDivision.name;
    if (compassDivision.timezone) division.timezone = compassDivision.timezone;
    division.status = compassDivision.status;
    division.source = sourceOf(compassDivision.externalId, syncedAt);
    await division.save();
    if (isNew) {
      summary.divisions.created += 1;
      await joinOpenPeriods(division);
      mongoDivisions.push(division);
      divisionByNumber.set(compassDivision.divisionNumber.toLowerCase(), division);
    } else if (!wasCompass) summary.divisions.adopted += 1;
    else summary.divisions.updated += 1;
    divisionByExternalId.set(compassDivision.externalId, division);
    managedDivisionIds.add(id(division._id));
    const divisionLease = division.liftLease?.configured
      ? { amount: division.liftLease.amount, frequency: division.liftLease.frequency }
      : null;

    const providersInDivision = mongoProviders.filter((provider) => id(provider.divisionId) === id(division._id));
    const providerByExternalId = new Map(providersInDivision
      .filter((provider) => provider.source?.system === 'COMPASS' && provider.source.externalId)
      .map((provider) => [id(provider.source.externalId), provider]));
    const providerByName = new Map(providersInDivision.map((provider) => [normalizeName(provider.name), provider]));

    for (const compassProvider of compassDivision.providers) {
      const providerKey = `${id(division._id)}|${compassProvider.externalId}`;
      desiredProviderKeys.add(providerKey);
      let provider = providerByExternalId.get(compassProvider.externalId) || providerByName.get(normalizeName(compassProvider.name));
      const isNewProvider = !provider;
      const wasCompassProvider = provider?.source?.system === 'COMPASS';
      if (!provider) provider = new Provider({ divisionId: division._id, name: compassProvider.name });
      const before = isNewProvider ? null : rosterSignature(provider);
      provider.divisionId = division._id;
      provider.name = compassProvider.name;
      provider.status = compassProvider.status;
      provider.source = sourceOf(compassProvider.externalId, syncedAt);

      const localByExternalId = new Map((provider.operators || [])
        .filter((operator) => !operator.transferredTo?.providerId && operator.source?.system === 'COMPASS' && operator.source.externalId)
        .map((operator) => [id(operator.source.externalId), operator]));
      const localByName = new Map((provider.operators || [])
        .filter((operator) => !operator.transferredTo?.providerId)
        .map((operator) => [normalizeName(operator.name), operator]));
      const matchedLocalIds = new Set();
      const nextOperators = [];

      for (const compassOperator of compassProvider.operators) {
        let previous = localByExternalId.get(compassOperator.externalId);
        let adopted = false;
        let keepIdentity = true;
        if (!previous) {
          previous = localByName.get(normalizeName(compassOperator.name));
          adopted = Boolean(previous);
        }
        if (!previous) {
          const elsewhere = globalOperatorByExternalId.get(compassOperator.externalId);
          if (elsewhere) { previous = elsewhere.operator; keepIdentity = false; }
        }
        if (previous?._id && keepIdentity) matchedLocalIds.add(id(previous._id));
        nextOperators.push(compassOperatorValue(compassOperator, previous, syncedAt, { keepIdentity, divisionLease }));
        if (!previous) summary.operators.created += 1;
        else if (adopted) summary.operators.adopted += 1;
        else summary.operators.updated += 1;
      }

      for (const previous of provider.operators || []) {
        if (matchedLocalIds.has(id(previous._id))) continue;
        const value = plainOperator(previous);
        if (previous.transferredTo?.providerId) { nextOperators.push(value); continue; }
        if (previous.status !== 'INACTIVE') summary.operators.deactivated += 1;
        nextOperators.push({ ...value, status: 'INACTIVE' });
      }
      provider.operators = nextOperators;
      await provider.save();
      const after = rosterSignature(provider);
      if (before !== after) changedProviderIds.add(id(provider._id));
      if (isNewProvider) { summary.providers.created += 1; mongoProviders.push(provider); }
      else if (!wasCompassProvider) summary.providers.adopted += 1;
      else summary.providers.updated += 1;
      providerByExternalId.set(compassProvider.externalId, provider);
    }
  }

  // A complete Compass snapshot controls every provider inside the divisions it returned.
  // Records in absent divisions (notably the current MongoDB-only DIV 12) are untouched.
  for (const provider of mongoProviders) {
    if (!managedDivisionIds.has(id(provider.divisionId))) continue;
    const key = `${id(provider.divisionId)}|${id(provider.source?.externalId)}`;
    if (provider.source?.system === 'COMPASS' && desiredProviderKeys.has(key)) continue;
    if (provider.status !== 'INACTIVE') {
      provider.status = 'INACTIVE';
      await provider.save();
      changedProviderIds.add(id(provider._id));
      summary.providers.deactivated += 1;
    }
  }

  if (changedProviderIds.size) {
    await markStale({ providerId: { $in: [...changedProviderIds] } });
    summary.staleProviders = changedProviderIds.size;
  }
  return { syncedAt, retrievedAt: normalized.retrievedAt, summary };
}

let activeSync = null;

export async function syncCompassRoster({ snapshot = null } = {}) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const settings = await getCompanySettings();
    settings.compassRoster.lastAttemptAt = new Date();
    settings.compassRoster.lastSyncStatus = 'RUNNING';
    settings.compassRoster.lastError = null;
    await settings.save();
    try {
      const result = await performCompassSync(snapshot || await readCompassSnapshot());
      settings.compassRoster.lastSyncAt = result.syncedAt;
      settings.compassRoster.lastSyncStatus = 'SUCCESS';
      settings.compassRoster.lastSummary = result.summary;
      settings.compassRoster.lastError = null;
      await settings.save();
      return result;
    } catch (error) {
      settings.compassRoster.lastSyncStatus = 'FAILED';
      settings.compassRoster.lastError = String(error.message || error).slice(0, 1000);
      await settings.save().catch(() => {});
      throw error;
    }
  })();
  try { return await activeSync; } finally { activeSync = null; }
}

export async function compassRosterSettings() {
  const settings = await getCompanySettings();
  return settings.compassRoster.toObject ? settings.compassRoster.toObject() : settings.compassRoster;
}

export async function updateCompassRosterSettings(body) {
  const settings = await getCompanySettings();
  if (body.automaticSyncEnabled !== undefined) settings.compassRoster.automaticSyncEnabled = Boolean(body.automaticSyncEnabled);
  if (body.syncIntervalMinutes !== undefined) {
    const minutes = Number(body.syncIntervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw badRequest('Compass refresh interval must be a whole number from 1 to 1440 minutes.');
    }
    settings.compassRoster.syncIntervalMinutes = minutes;
  }
  await settings.save();
  return compassRosterSettings();
}
