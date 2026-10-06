import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const sourceSchema = new mongoose.Schema(
  {
    system: { type: String, enum: ['MANUAL', 'COMPASS'], default: 'MANUAL' },
    externalId: { type: String, trim: true, default: null },
    lastSyncedAt: { type: Date, default: null },
  },
  { _id: false },
);

const divisionSchema = new mongoose.Schema(
  {
    divisionNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    timezone: { type: String, default: 'America/Los_Angeles' },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    notes: String,
    source: { type: sourceSchema, default: () => ({}) },
    // How this division's VDP cycles are generated. Can evolve per division.
    cycleSettings: {
      anchorDate: { type: Date, default: () => new Date('2026-08-24T00:00:00Z') },
      lengthDays: { type: Number, default: 14, enum: [14] },
      submissionOffsetDays: { type: Number, default: 15, min: 0 },
      paymentOffsetDays: { type: Number, default: 4, min: 0 },
    },
  },
  jsonOptions,
);

divisionSchema.index(
  { 'source.system': 1, 'source.externalId': 1 },
  { unique: true, partialFilterExpression: { 'source.system': 'COMPASS', 'source.externalId': { $type: 'string' } } },
);

export default mongoose.model('Division', divisionSchema);
