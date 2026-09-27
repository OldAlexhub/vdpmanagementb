import mongoose from 'mongoose';
import { dec, jsonOptions } from './common.js';

const { Schema } = mongoose;

const leaseSchema = {
  amount: dec({ default: null }),
  frequency: { type: String, enum: ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'], default: 'NONE' },
};

const transferSchema = new Schema(
  {
    providerId: { type: Schema.Types.ObjectId, ref: 'Provider' },
    providerName: String,
    effectiveDate: String, // first day with the new provider
    note: String,
    by: { id: { type: Schema.Types.ObjectId, ref: 'User' }, name: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

// An operator (driver) working for the provider. The provider is the one who gets paid;
// each operator's routes are measured against their own contract, then summed into one VDP.
const operatorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    routes: { type: [String], default: [] }, // run/route numbers as they appear on the Performance Report
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    contractedHours: dec({ default: null }), // null = provider override, else plan
    liftLease: leaseSchema, // per operator (vehicle)
    notes: String,
    // Dates this operator works for this provider (YYYY-MM-DD, inclusive; null = open).
    // Set by a transfer between providers so report days before/after it go to the right one.
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    transferredFrom: transferSchema,
    transferredTo: transferSchema,
  },
  { toJSON: { getters: true, versionKey: false }, toObject: { getters: true } },
);

const providerSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    providerNumber: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    operators: { type: [operatorSchema], default: [] },
    // Derived from active operators when the provider has any (kept for matching, search and lists).
    // Providers saved before operators existed still use these directly — see services/operators.js.
    operatorName: { type: String, trim: true },
    routes: { type: [String], default: [] },
    serviceType: { type: String, trim: true },
    planId: { type: Schema.Types.ObjectId, ref: 'VdpPlan', default: null },
    liftLease: leaseSchema, // legacy single-operator lease; unused once operators are set
    // Only set when this provider differs from their plan. Null = inherit.
    overrides: {
      contractedHours: dec({ default: null }),
      basePay: dec({ default: null }),
      bonusRate: dec({ default: null }),
      tuiEligibility: { type: String, enum: ['INHERIT', 'ON', 'OFF'], default: 'INHERIT' },
    },
    contact: {
      email: String,
      phone: String,
      address: String,
    },
    notes: String,
  },
  jsonOptions,
);

providerSchema.pre('validate', function syncFromOperators() {
  if (!this.operators.length) return;
  const active = this.operators.filter((o) => o.status === 'ACTIVE');
  // Routes of an operator who moved away stay listed so earlier cycles still match here.
  this.routes = [...new Set(active.flatMap((o) => o.routes))];
  const today = new Date().toISOString().slice(0, 10);
  this.operatorName = active.filter((o) => !o.endDate || o.endDate >= today).map((o) => o.name).join(', ');
  this.liftLease = { amount: null, frequency: 'NONE' };
});

providerSchema.index({ divisionId: 1, providerNumber: 1 });
providerSchema.index({ divisionId: 1, routes: 1 });

export default mongoose.model('Provider', providerSchema);
