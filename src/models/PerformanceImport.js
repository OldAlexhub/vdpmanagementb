import mongoose from 'mongoose';
import { dec, jsonOptions, actorSchema } from './common.js';

const { Schema } = mongoose;

// One row per date + route, exactly as summed from the report.
const rowSchema = new Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD
    route: { type: String, required: true },
    compassDerived: { type: Boolean, default: false }, // materialized Compass metrics are never uploaded fallback
    trips: dec(),
    totalHours: dec({ default: null }),
    serviceHours: dec({ default: null }),
    revenueHours: dec({ default: null }),
    serviceMiles: dec({ default: null }), // Miles → Service; null = not in the report or blank
    otherHours: { type: Map, of: String, default: {} },
    tui: mongoose.Schema.Types.Mixed,
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
    // Optional at import time. The selected VDP Plan determines whether the
    // calculation requires this metric.
    utilizedHours: dec({ default: null }),
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

const uberTollRowSchema = new Schema(
  {
    week: { type: String, required: true },
    endExclusive: { type: String, required: true },
    driverUuid: { type: String, required: true, trim: true },
    sourceFirstName: String,
    sourceLastName: String,
    amount: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

// DIV 3 duty exports are reduced to the driver/day grain used by the source
// workbook. This keeps the 40k+ row GoLink exports below MongoDB's document
// limit while preserving every value needed to reproduce weekly results.
const division3DutyRowSchema = new Schema(
  {
    service: { type: String, enum: ['ADA', 'GOLINK'], required: true },
    date: { type: String, required: true },
    driverName: { type: String, required: true },
    dutyCount: { type: Number, required: true },
    paidHours: dec({ required: true }),
    attainmentHours: dec({ required: true }),
    revenueHours: dec({ required: true }),
    pauseHours: dec({ required: true }),
    breakHours: dec({ required: true }),
    scheduledStart: String,
    scheduledEnd: String,
    firstSeen: String,
    lastSeen: String,
    lateStart: { type: Boolean, default: false },
    earlyEnd: { type: Boolean, default: false },
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division3FareRowSchema = new Schema(
  {
    date: { type: String, required: true },
    driverName: { type: String, required: true },
    tripCount: { type: Number, required: true },
    adultRiders: dec({ required: true }),
    fareCost: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division3ReturnedFareRowSchema = new Schema(
  {
    partnerName: { type: String, required: true },
    driverName: { type: String, required: true },
    date: { type: String, required: true },
    fareToCollect: dec({ required: true }),
    route1029: dec({ required: true }),
    orangeCouponCount: dec({ required: true }),
    greenCouponCount: dec({ required: true }),
    orangeCoupon: dec({ required: true }),
    greenCoupon: dec({ required: true }),
    stripe: dec({ required: true }),
    wallet: dec({ required: true }),
    cashToDeduct: dec({ required: true }),
    schemaComplete: { type: Boolean, default: false },
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division3DriverMatchSchema = new Schema(
  {
    sourceName: { type: String, required: true },
    // Older imports did not store this because names were matched across both
    // services. New matches are service-specific so ADA and GoLink can resolve
    // to their own Compass division/provider pay units.
    service: { type: String, enum: ['ADA', 'GOLINK'], default: null },
    providerId: { type: Schema.Types.ObjectId, ref: 'Provider', required: true },
    operatorId: { type: String, required: true },
    method: { type: String, enum: ['AUTO_EXACT_NAME', 'AUTO_SMART_NAME', 'MANUAL'], required: true },
    confidence: dec({ default: null }),
    matchedBy: actorSchema,
    matchedAt: { type: Date, default: Date.now },
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division3DriverExclusionSchema = new Schema(
  {
    sourceName: { type: String, required: true },
    service: { type: String, enum: ['ADA', 'GOLINK'], required: true },
    reason: { type: String, trim: true, default: 'Set aside for this VDP cycle' },
    excludedBy: actorSchema,
    excludedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// DIV 10 source reports are normalized at upload time. Only the route/day or
// operator/day facts used by the VDP are retained; the raw source workbooks
// and manifest event dumps are never stored in MongoDB.
const division10ManifestRowSchema = new Schema(
  {
    date: { type: String, required: true },
    route: { type: String, required: true },
    operatorName: String,
    actualStartMinutes: { type: Number, required: true },
    actualEndMinutes: { type: Number, required: true },
    actualHours: dec({ required: true }),
    lunchHours: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division10FareRowSchema = new Schema(
  {
    date: { type: String, required: true },
    route: { type: String, required: true },
    operatorName: String,
    cashFares: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const division10FuelRowSchema = new Schema(
  {
    date: { type: String, required: true },
    operatorName: { type: String, required: true },
    amount: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const sourceAdjustmentRowSchema = new Schema(
  {
    date: { type: String, required: true },
    providerName: { type: String, trim: true, default: null },
    operatorName: { type: String, trim: true, default: null },
    type: { type: String, enum: ['FARES', 'FUEL', 'OTHER_DEDUCTION', 'OTHER_INCOME'], required: true },
    amount: dec({ required: true }),
    description: String,
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const importSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'VdpCycle', required: true },
    kind: { type: String, enum: ['STANDARD', 'COMPASS', 'UBER', 'UBER_TOLLS', 'DIV3_ADA', 'DIV3_GOLINK', 'DIV3_ADA_FARE', 'DIV3_RETURNED_FARE', 'DIVISION_SOURCE'], default: 'STANDARD', index: true },
    // Exact source slot from the division-specific upload contract. Keeping a
    // single kind avoids pretending these unlike reports share one schema.
    datasetType: { type: String, trim: true, default: null, index: true },
    originalFileName: { type: String, required: true },
    fileHash: { type: String, required: true },
    fileSize: Number,
    uploadedBy: actorSchema,
    uploadedAt: { type: Date, default: Date.now },
    rowCount: Number, // report rows inside the cycle
    status: { type: String, enum: ['STAGED', 'ACTIVE', 'REPLACED', 'INVALID'], default: 'ACTIVE' },
    validationStatus: { type: String, enum: ['VALID', 'INVALID'], default: 'VALID' },
    processingErrors: { type: [String], default: [] },
    replacedAt: Date,
    replacedBy: actorSchema,
    replaceReason: String,
    supersedesImportId: { type: Schema.Types.ObjectId, ref: 'PerformanceImport', default: null },
    supersededByImportId: { type: Schema.Types.ObjectId, ref: 'PerformanceImport', default: null },
    reportRange: { from: String, to: String },
    dataRange: { from: String, to: String },
    detectedColumns: Schema.Types.Mixed,
    stats: Schema.Types.Mixed,
    warnings: [String],
    rows: { type: [rowSchema], default: [] },
    uberRows: { type: [uberRowSchema], default: [] },
    uberDriverMatches: { type: [uberDriverMatchSchema], default: [] },
    uberTollRows: { type: [uberTollRowSchema], default: [] },
    division3DutyRows: { type: [division3DutyRowSchema], default: [] },
    division3FareRows: { type: [division3FareRowSchema], default: [] },
    division3ReturnedFareRows: { type: [division3ReturnedFareRowSchema], default: [] },
    division3DriverMatches: { type: [division3DriverMatchSchema], default: [] },
    division3DriverExclusions: { type: [division3DriverExclusionSchema], default: [] },
    division10ManifestRows: { type: [division10ManifestRowSchema], default: [] },
    division10FareRows: { type: [division10FareRowSchema], default: [] },
    division10FuelRows: { type: [division10FuelRowSchema], default: [] },
    sourceAdjustmentRows: { type: [sourceAdjustmentRowSchema], default: [] },
    datesDetected: { type: [String], default: [] },
    weeksDetected: { type: [String], default: [] },
    driversDetected: { type: Number, default: 0 },
    routeResolutions: { type: [routeResolutionSchema], default: [] },
  },
  jsonOptions,
);

importSchema.index({ cycleId: 1, status: 1 });
importSchema.index({ cycleId: 1, kind: 1, status: 1 });
importSchema.index({ cycleId: 1, kind: 1, datasetType: 1, status: 1 });
importSchema.index({ cycleId: 1, fileHash: 1 });

export default mongoose.model('PerformanceImport', importSchema);
