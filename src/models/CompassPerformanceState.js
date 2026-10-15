import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

// One atomic revision/pointer per pay period. Corrections are independent of
// immutable source snapshots, and their history survives source replacement.
const schema = new mongoose.Schema({
  cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'VdpCycle', required: true, unique: true },
  revision: { type: Number, default: 0 },
  activeImportId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerformanceImport', default: null },
  lastAttemptAt: Date,
  lastSyncedAt: Date,
  lastError: { type: String, default: null },
  lock: { type: String, default: null },
  lockUntil: Date,
  corrections: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, jsonOptions);

export default mongoose.model('CompassPerformanceState', schema);
