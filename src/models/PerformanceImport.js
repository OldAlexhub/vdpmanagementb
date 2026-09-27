import mongoose from 'mongoose';
import { dec, jsonOptions, actorSchema } from './common.js';

const { Schema } = mongoose;

// One row per date + route, exactly as summed from the report.
const rowSchema = new Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD
    route: { type: String, required: true },
    trips: dec(),
    totalHours: dec({ default: null }),
    serviceHours: dec({ default: null }),
    revenueHours: dec({ default: null }),
    otherHours: { type: Map, of: String, default: {} },
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const routeResolutionSchema = new Schema(
  {
    route: { type: String, required: true },
    action: { type: String, enum: ['ASSIGN', 'IGNORE'], required: true },
    providerId: { type: Schema.Types.ObjectId, ref: 'Provider', default: null },
    note: String,
    resolvedBy: actorSchema,
    resolvedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const importSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'VdpCycle', required: true },
    originalFileName: { type: String, required: true },
    fileHash: { type: String, required: true },
    fileSize: Number,
    uploadedBy: actorSchema,
    uploadedAt: { type: Date, default: Date.now },
    rowCount: Number, // report rows inside the cycle
    status: { type: String, enum: ['ACTIVE', 'REPLACED'], default: 'ACTIVE' },
    replacedAt: Date,
    replacedBy: actorSchema,
    replaceReason: String,
    reportRange: { from: String, to: String },
    dataRange: { from: String, to: String },
    detectedColumns: Schema.Types.Mixed,
    stats: Schema.Types.Mixed,
    warnings: [String],
    rows: { type: [rowSchema], default: [] },
    routeResolutions: { type: [routeResolutionSchema], default: [] },
  },
  jsonOptions,
);

importSchema.index({ cycleId: 1, status: 1 });
importSchema.index({ cycleId: 1, fileHash: 1 });

export default mongoose.model('PerformanceImport', importSchema);
