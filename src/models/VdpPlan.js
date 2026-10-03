import mongoose from 'mongoose';
import { dec, jsonOptions, actorSchema } from './common.js';

const { Schema } = mongoose;

const tierSchema = new Schema(
  {
    minimumPercentage: dec({ required: true }),
    maximumPercentage: dec({ default: null }),
    rate: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

// Uber incentives use ratios (0.94 = 94%) rather than the legacy plan tier's
// percentage points. Minimum tiers are used for fulfillment/acceptance;
// maximum tiers are used for cancellation. The version owns every threshold
// so a historical VDP can always be reproduced from its snapshot.
const uberMinimumTierSchema = new Schema(
  {
    minimum: dec({ required: true }),
    rate: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const uberMaximumTierSchema = new Schema(
  {
    maximum: dec({ required: true }),
    rate: dec({ required: true }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

const uberConfigSchema = new Schema(
  {
    coreRatePct: dec({ default: null }),
    approvedExtraHours: dec({ default: 0 }),
    contractHoursIncentiveTiers: { type: [uberMinimumTierSchema], default: [] },
    acceptanceIncentiveTiers: { type: [uberMinimumTierSchema], default: [] },
    cancellationIncentiveTiers: { type: [uberMaximumTierSchema], default: [] },
    utilizationTarget: dec({ default: null }),
    utilizationIncentivePct: dec({ default: null }),
    coreHoursRequirement: dec({ default: null }),
  },
  { _id: false, toJSON: { getters: true }, toObject: { getters: true } },
);

// A version holds the compensation rules for a date range. Rules are never edited
// once an approved VDP has used them — a new version is created instead.
const versionSchema = new Schema(
  {
    versionNumber: { type: Number, required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    calculationType: { type: String, enum: ['STANDARD', 'UBER'], default: 'STANDARD' },
    paymentType: { type: String, enum: ['HOURLY', 'PER_TRIP'], required: true },
    // Standard plans own base pay. Uber rates live on each operator profile.
    basePay: dec({ default: null }),
    contractedHours: dec({ default: null }),
    incentiveEnabled: { type: Boolean, default: false }, // TUI eligibility for everyone on the plan
    incentiveTiers: { type: [tierSchema], default: [] },
    bonusEnabled: { type: Boolean, default: false },
    bonusRate: dec({ default: null }),
    // Fuel arrangement. NONE; PER_TRIP = trips × rate added after Gross; SERVICE_MILE_ALLOWANCE =
    // each day's service miles ÷ MPG (fuelMpg, e.g. 19) × that day's fuel price (plan.fuelPrices) is the
    // most fuel may cost, and only the actual expense above it is deducted. Versions saved before
    // fuelMethod existed: see fuelMethodOf().
    fuelMethod: { type: String, enum: ['NONE', 'PER_TRIP', 'SERVICE_MILE_ALLOWANCE', null], default: null },
    fuelReimbursementEnabled: { type: Boolean, default: false }, // = fuelMethod PER_TRIP
    fuelReimbursementRate: dec({ default: null }), // $ per trip
    fuelMpg: dec({ default: null }), // miles per gallon for SERVICE_MILE_ALLOWANCE
    fuelMileageSource: { type: String, enum: ['SERVICE_MILES'], default: 'SERVICE_MILES' },
    performanceHourMetric: {
      type: String,
      enum: ['TOTAL_HOURS', 'SERVICE_HOURS', 'REVENUE_HOURS', 'OTHER'],
      default: 'TOTAL_HOURS',
    },
    performanceHourColumn: { type: String, default: null }, // only for OTHER
    uberConfig: { type: uberConfigSchema, default: undefined },
    notes: String,
    createdBy: actorSchema,
  },
  { timestamps: true, toJSON: { getters: true, versionKey: false }, toObject: { getters: true } },
);

// Fuel price per gallon by date, for the service mile allowance. Kept on the plan (not a version)
// because it changes often; approved VDPs keep the prices they were calculated with.
const fuelPriceSchema = new Schema(
  {
    pricePerGallon: dec({ required: true }),
    effectiveFrom: { type: String, required: true }, // YYYY-MM-DD, inclusive
    effectiveTo: { type: String, default: null }, // YYYY-MM-DD, inclusive; null = open-ended
    notes: String,
    updatedBy: actorSchema,
    updatedAt: { type: Date, default: Date.now },
  },
  { toJSON: { getters: true, versionKey: false }, toObject: { getters: true } },
);

const planSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    notes: String,
    versions: { type: [versionSchema], default: [] },
    fuelPrices: { type: [fuelPriceSchema], default: [] },
  },
  jsonOptions,
);

planSchema.index({ divisionId: 1, name: 1 }, { unique: true });

export default mongoose.model('VdpPlan', planSchema);
