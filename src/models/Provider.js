import mongoose from 'mongoose';
import { dec, jsonOptions } from './common.js';

const { Schema } = mongoose;

const providerSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    providerNumber: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    operatorName: { type: String, trim: true },
    routes: { type: [String], default: [] }, // run/route numbers as they appear on the Performance Report
    serviceType: { type: String, trim: true },
    planId: { type: Schema.Types.ObjectId, ref: 'VdpPlan', default: null },
    liftLease: {
      amount: dec({ default: null }),
      frequency: { type: String, enum: ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'], default: 'NONE' },
    },
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

providerSchema.index({ divisionId: 1, providerNumber: 1 });
providerSchema.index({ divisionId: 1, routes: 1 });

export default mongoose.model('Provider', providerSchema);
