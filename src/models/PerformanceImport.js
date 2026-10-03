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
    serviceMiles: dec({ default: null }), // Miles → Service; null = not in the report or blank
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

// Normalized, auditable Uber source row. The original workbook is not needed
// to reproduce a VDP after these values and the plan snapshot are stored.
const uberRowSchema = new Schema(
  {
    week: { type: String, required: true }, // YYYY-MM-DD from the source Week column
    driverUuid: { type: String, required: true, trim: true },
    // Optional source spelling used only for smart matching. The provider
    // profile remains the canonical operator identity.
    sourceFirstName: String,
    sourceLastName: String,
    // Source columns where Uber supplied its \N null sentinel. The parser uses
    // exact zero for calculation but keeps the field names for audit.
    sourceZeroFields: { type: [String], default: [] },
    totalSupplyHours: dec({ required: true }),
    pausedHours: dec({ required: true }),
    coreHoursTotalSupplyHours: dec({ required: true }),
    utilizedHours: dec({ required: true }),
    totalAccepts: dec({ required: true }),
    totalRejects: dec({ required: true }),
    totalExpiredOffers: dec({ required: true }),
    totalCancels: dec({ required: true }),
    driverEarningsExclTips: dec({ required: true }),
    driverTips: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

// Resolution metadata belongs to the uploaded source, not to the provider
// profile. It links one Uber source driver to an internal operator for this
// import/cycle while keeping the external UUID out of provider master data.
const uberDriverMatchSchema = new Schema(
  {
    driverUuid: { type: String, required: true, trim: true },
    providerId: { type: Schema.Types.ObjectId, ref: 'Provider', required: true },
    operatorId: { type: String, required: true },
    method: { type: String, enum: ['AUTO_EXACT_NAME', 'MANUAL'], required: true },
    confidence: dec({ default: null }),
    matchedBy: actorSchema,
    matchedAt: { type: Date, default: Date.now },
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const importSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'VdpCycle', required: true },
    kind: { type: String, enum: ['STANDARD', 'UBER'], default: 'STANDARD', index: true },
    originalFileName: { type: String, required: true },
    fileHash: { type: String, required: true },
    fileSize: Number,
    uploadedBy: actorSchema,
    uploadedAt: { type: Date, default: Date.now },
    rowCount: Number, // report rows inside the cycle
    status: { type: String, enum: ['ACTIVE', 'REPLACED', 'INVALID'], default: 'ACTIVE' },
    validationStatus: { type: String, enum: ['VALID', 'INVALID'], default: 'VALID' },
    processingErrors: { type: [String], default: [] },
    replacedAt: Date,
    replacedBy: actorSchema,
    replaceReason: String,
    reportRange: { from: String, to: String },
    dataRange: { from: String, to: String },
    detectedColumns: Schema.Types.Mixed,
    stats: Schema.Types.Mixed,
    warnings: [String],
    rows: { type: [rowSchema], default: [] },
    uberRows: { type: [uberRowSchema], default: [] },
    uberDriverMatches: { type: [uberDriverMatchSchema], default: [] },
    weeksDetected: { type: [String], default: [] },
    driversDetected: { type: Number, default: 0 },
    routeResolutions: { type: [routeResolutionSchema], default: [] },
  },
  jsonOptions,
);

importSchema.index({ cycleId: 1, status: 1 });
importSchema.index({ cycleId: 1, kind: 1, status: 1 });
importSchema.index({ cycleId: 1, fileHash: 1 });

export default mongoose.model('PerformanceImport', importSchema);
