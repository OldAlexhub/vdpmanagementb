// Loads an Extended JSON export (one <collection>.json array per collection) into a database,
// keeping ObjectIds, dates and Decimal128 money values exactly as exported.
//
//   node scripts/importJson.js <folder> --uri "<target MONGO_URI>" [--db bigstar_vdp] [--drop]
//
// Without --drop, a collection that already has documents is skipped (nothing is overwritten).
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { EJSON } from 'bson';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const folder = args.find((a, i) => !a.startsWith('--') && !['--uri', '--db'].includes(args[i - 1]));
const uri = flag('--uri');
const dbName = flag('--db') || 'bigstar_vdp';
const drop = args.includes('--drop');

if (!folder || !uri) {
  console.error('Usage: node scripts/importJson.js <folder> --uri "<target MONGO_URI>" [--db bigstar_vdp] [--drop]');
  process.exit(1);
}

const files = fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort();
const conn = await mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 15000 }).asPromise();
console.log(`Importing ${files.length} file(s) into database "${dbName}"`);

let failed = false;
for (const file of files) {
  const name = path.basename(file, '.json');
  const docs = EJSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'), { relaxed: false });
  const col = conn.db.collection(name);
  const existing = await col.countDocuments();
  if (existing && !drop) {
    console.log(`${name.padEnd(20)} skipped: already has ${existing} document(s) (use --drop to replace)`);
    continue;
  }
  try {
    if (existing) await col.deleteMany({});
    if (docs.length) await col.insertMany(docs, { ordered: false });
    console.log(`${name.padEnd(20)} ${docs.length} imported`);
  } catch (err) {
    failed = true;
    console.error(`${name.padEnd(20)} FAILED: ${err.message}`);
  }
}

await conn.close();
process.exit(failed ? 1 : 0);
