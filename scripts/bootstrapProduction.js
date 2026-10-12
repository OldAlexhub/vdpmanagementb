import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import PlanBlueprint from '../src/models/PlanBlueprint.js';
import DatasetRequirement from '../src/models/DatasetRequirement.js';
import { getCompanySettings } from '../src/models/CompanySettings.js';
import { planTemplates } from '../src/services/planTemplates.js';
import { contractForDivisionNumber, publicSourceDefinition } from '../src/services/divisionSourceDefinitions.js';
import { syncCompassRoster } from '../src/services/compassRosterService.js';

const specialRequirements = [
  ['2', 'UBER_WEEKLY', 'Uber weekly reports', 'GLOBAL_REQUIRED', 'REQUIRED'],
  ['2', 'UBER_TOLLS', 'Uber toll reimbursement', 'OPTIONAL', 'ADDITIONAL'],
  ['3', 'DIV3_ADA', 'ADA Duty', 'GLOBAL_REQUIRED', 'REQUIRED'],
  ['3', 'DIV3_GOLINK', 'GoLink Duty', 'GLOBAL_REQUIRED', 'REQUIRED'],
  ['3', 'DIV3_ADA_FARE', 'ADA Fare', 'NSM_RECONCILIATION', 'ADDITIONAL'],
  ['3', 'DIV3_RETURNED_FARE', 'Returned-fare reconciliation', 'NSM_RECONCILIATION', 'ADDITIONAL'],
  ['3', 'UBER_WEEKLY', 'Uber weekly reports', 'OPTIONAL', 'REQUIRED'],
  ['3', 'UBER_TOLLS', 'Uber toll reimbursement', 'PROVIDER_CONDITIONAL', 'ADDITIONAL'],
  ['12', 'UBER_WEEKLY', 'Uber weekly reports', 'GLOBAL_REQUIRED', 'REQUIRED'],
  ['12', 'UBER_TOLLS', 'Applicable toll reimbursement', 'PROVIDER_CONDITIONAL', 'ADDITIONAL'],
];

async function assertCleanDatabase() {
  const names = (await mongoose.connection.db.listCollections().toArray()).map((item) => item.name);
  const ignored = new Set(['system.profile']);
  const populated = [];
  for (const name of names.filter((item) => !ignored.has(item))) {
    const count = await mongoose.connection.db.collection(name).estimatedDocumentCount();
    if (count) populated.push({ name, count });
  }
  if (populated.length) throw new Error(`Production bootstrap requires a clean database. Existing collections: ${populated.map((item) => `${item.name} (${item.count})`).join(', ')}`);
}

async function bootstrap() {
  if (process.env.NODE_ENV !== 'production' && !process.argv.includes('--allow-non-production')) {
    throw new Error('Set NODE_ENV=production, or pass --allow-non-production for a staging rehearsal.');
  }
  await connectDb();
  await assertCleanDatabase();
  const blueprints = planTemplates().map((template) => ({
    key: template.id,
    version: template.blueprintVersion,
    name: template.name,
    divisionNumber: template.divisionNumber,
    variant: template.variant,
    sourceDocument: template.sourceDocument,
    sourceChecksum: template.sourceChecksum,
    specification: template.version,
    processingEnabled: template.processingEnabled,
    validation: { ...template.validation, verifiedAt: new Date() },
    status: template.validation.reconciliationPassed ? 'APPROVED' : 'DRAFT',
  }));
  await PlanBlueprint.insertMany(blueprints);

  const requirements = [];
  for (const divisionNumber of ['5', '6', '7', '8', '10', '11']) {
    for (const definition of contractForDivisionNumber(divisionNumber)) {
      const item = publicSourceDefinition(definition);
      requirements.push({
        divisionNumber,
        datasetType: item.id,
        label: item.title,
        classification: item.classification,
        stage: item.stage,
        schemaVersion: item.schemaVersion,
      });
    }
  }
  requirements.push(...specialRequirements.map(([divisionNumber, datasetType, label, classification, stage]) => ({ divisionNumber, datasetType, label, classification, stage })));
  await DatasetRequirement.insertMany(requirements);
  await getCompanySettings();
  if (!process.argv.includes('--skip-compass')) await syncCompassRoster();
  console.log(JSON.stringify({ ok: true, blueprints: blueprints.length, datasetRequirements: requirements.length, compass: process.argv.includes('--skip-compass') ? 'skipped' : 'synced' }));
}

bootstrap().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(disconnectDb);
