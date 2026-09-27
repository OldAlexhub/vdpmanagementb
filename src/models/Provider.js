import mongoose from 'mongoose';
import { dec, jsonOptions } from './common.js';

const { Schema } = mongoose;

const leaseSchema = {
  amount: dec({ default: null }),
  frequency: { type: String, enum: ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'], default: 'NONE' },
};

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
  this.routes = [...new Set(active.flatMap((o) => o.routes))];
  this.operatorName = active.map((o) => o.name).join(', ');
  this.liftLease = { amount: null, frequency: 'NONE' };
});

providerSchema.index({ divisionId: 1, providerNumber: 1 });
providerSchema.index({ divisionId: 1, routes: 1 });

export default mongoose.model('Provider', providerSchema);
