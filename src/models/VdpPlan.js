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

// A version holds the compensation rules for a date range. Rules are never edited
// once an approved VDP has used them — a new version is created instead.
const versionSchema = new Schema(
  {
    versionNumber: { type: Number, required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    paymentType: { type: String, enum: ['HOURLY', 'PER_TRIP'], required: true },
    basePay: dec({ required: true }),
    contractedHours: dec({ default: null }),
    incentiveEnabled: { type: Boolean, default: false }, // TUI eligibility for everyone on the plan
    incentiveTiers: { type: [tierSchema], default: [] },
    bonusEnabled: { type: Boolean, default: false },
    bonusRate: dec({ default: null }),
    // Fuel reimbursement: trips × rate, added to the VDP after Gross. Off = nothing added.
    fuelReimbursementEnabled: { type: Boolean, default: false },
    fuelReimbursementRate: dec({ default: null }), // $ per trip
    performanceHourMetric: {
      type: String,
      enum: ['TOTAL_HOURS', 'SERVICE_HOURS', 'REVENUE_HOURS', 'OTHER'],
      default: 'TOTAL_HOURS',
    },
    performanceHourColumn: { type: String, default: null }, // only for OTHER
    notes: String,
    createdBy: actorSchema,
  },
  { timestamps: true, toJSON: { getters: true, versionKey: false }, toObject: { getters: true } },
);

const planSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    notes: String,
    versions: { type: [versionSchema], default: [] },
  },
  jsonOptions,
);

planSchema.index({ divisionId: 1, name: 1 }, { unique: true });

export default mongoose.model('VdpPlan', planSchema);
