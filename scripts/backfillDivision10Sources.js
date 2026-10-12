// One-time-safe migration for DIV 10 uploads staged before the normalized
// source adapter existed. It reads only an exact same-named file from the
// audited artifacts folder and updates the existing import in place.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import VdpCycle from '../src/models/VdpCycle.js';
import PerformanceImport from '../src/models/PerformanceImport.js';
import Vdp from '../src/models/Vdp.js';
import { parseDivisionSourceFile } from '../src/services/divisionSourceParser.js';
import { DIV10_ADAPTER_VERSION, refreshDivision10DerivedImport } from '../src/services/division10Adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.resolve(here, '../../artifacts/VPDs/DIV10/VDP AUTOMATION');

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

const candidates = new Map();
for (const file of filesUnder(artifactRoot)) {
  const name = path.basename(file);
  const list = candidates.get(name) || [];
  list.push(file);
  candidates.set(name, list);
}

await connectDb();
try {
  const division = await Division.findOne({ divisionNumber: '10' });
  if (!division) throw new Error('DIV 10 is not configured.');
  const cycles = await VdpCycle.find({ divisionId: division._id });
  let updated = 0;
  let derived = 0;
  for (const cycle of cycles) {
    const imports = await PerformanceImport.find({
      cycleId: cycle._id,
      kind: 'DIVISION_SOURCE',
      status: 'ACTIVE',
      validationStatus: 'VALID',
      'stats.adapterVersion': { $ne: DIV10_ADAPTER_VERSION },
    });
    const activeSourceCount = await PerformanceImport.countDocuments({
      cycleId: cycle._id, kind: 'DIVISION_SOURCE', status: 'ACTIVE', validationStatus: 'VALID',
    });
    for (const doc of imports) {
      const matches = candidates.get(doc.originalFileName) || [];
      if (matches.length !== 1) {
        console.log(`Skipped ${doc.originalFileName}: expected one exact artifact, found ${matches.length}.`);
        continue;
      }
      const parsed = await parseDivisionSourceFile(
        fs.readFileSync(matches[0]), doc.originalFileName, '10', doc.datasetType, { cycle },
      );
      doc.rows = parsed.rows || [];
      doc.division10ManifestRows = parsed.division10ManifestRows || [];
      doc.division10FareRows = parsed.division10FareRows || [];
      doc.division10FuelRows = parsed.division10FuelRows || [];
      doc.detectedColumns = parsed.performanceColumns || parsed.detectedColumns || doc.detectedColumns;
      doc.warnings = parsed.warnings || [];
      doc.stats = {
        ...(doc.stats || {}),
        sheetName: parsed.sheetName || doc.stats?.sheetName || null,
        adapterVersion: DIV10_ADAPTER_VERSION,
        normalizedFromArtifact: path.relative(artifactRoot, matches[0]),
      };
      await doc.save();
      updated += 1;
      console.log(`Normalized ${doc.datasetType}: ${doc.originalFileName}`);
    }
    if (activeSourceCount) {
      const result = await refreshDivision10DerivedImport({ cycle, user: { name: 'DIV 10 source adapter migration' } });
      if (result) {
        derived += 1;
        await Vdp.updateMany(
          { cycleId: cycle._id, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } },
          { $set: { stale: true } },
        );
        console.log(`Ready ${cycle.cycleStart.toISOString().slice(0, 10)}: ${result.rowCount} normalized route/day rows.`);
      }
    }
  }
  console.log(`DIV 10 migration complete: ${updated} source file(s), ${derived} derived cycle import(s).`);
} finally {
  await disconnectDb();
}
