import mongoose from 'mongoose';
import { dec, jsonOptions, actorSchema } from './common.js';

const { Schema } = mongoose;

// APPROVED  = approved by Big Star and sent to the provider (awaiting provider approval)
// DISPUTED  = the provider reported an issue; auto-approval is paused until Big Star responds
// PROCESSED = approved by the provider, or auto-approved after the submission deadline; ready to pay
export const VDP_STATUSES = ['DRAFT', 'NEEDS_REVIEW', 'READY', 'APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'];

// What part of the statement a provider can say is wrong.
export const ISSUE_AREAS = {
  TRIPS: 'Trips',
  HOURS: 'Hours worked',
  CONTRACTED_HOURS: 'Contracted hours',
  RATE: 'Rate / incentive tier',
  BONUS: 'Bonus pay',
  LIFT_LEASE: 'Lift lease',
  FARES: 'Fares collected',
  ADJUSTMENT: 'A deduction or addition',
  MISSING: 'Something is missing',
  OTHER: 'Other',
};
export const ADJUSTMENT_TYPE_KEYS = [
  'FARES', 'FUEL', 'TOLL', 'LATE_DEPLOYMENT', 'VIOLATION', 'OTHER_DEDUCTION', 'REIMBURSEMENT', 'OTHER_INCOME',
];

const adjustmentSchema = new Schema(
  {
    type: { type: String, enum: ADJUSTMENT_TYPE_KEYS, required: true },
    amount: dec({ required: true }), // positive; the type sets the direction
    description: String,
    date: { type: Date, default: Date.now },
    createdBy: actorSchema,
    createdAt: { type: Date, default: Date.now },
  },
  { toJSON: { getters: true, versionKey: false }, toObject: { getters: true } },
);

const exceptionSchema = new Schema(
  { code: String, message: String, acknowledgeable: { type: Boolean, default: false } },
  { _id: false },
);

const acknowledgementSchema = new Schema(
  { code: String, note: String, by: actorSchema, at: { type: Date, default: Date.now } },
  { _id: false },
);

const issueItemSchema = new Schema(
  {
    area: { type: String, enum: Object.keys(ISSUE_AREAS), required: true },
    week: { type: Number, enum: [1, 2, null], default: null },
    adjustmentIndex: { type: Number, default: null },
    shownValue: String, // what the statement showed (filled by the server, never the client)
    expectedValue: String, // what the provider says it should be
    reason: { type: String, required: true },
  },
  { _id: false },
);

const issueSchema = new Schema(
  {
    items: { type: [issueItemSchema], default: [] },
    comment: String,
    status: { type: String, enum: ['OPEN', 'IN_CORRECTION', 'RESOLVED'], default: 'OPEN' },
    raisedBy: actorSchema,
    raisedAt: { type: Date, default: Date.now },
    netAtRaise: String,
    response: {
      action: { type: String, enum: ['NO_CHANGE', 'CORRECTED', null], default: null },
      message: String,
      by: actorSchema,
      at: Date,
      newNet: String,
    },
  },
  { toJSON: { versionKey: false } },
);

const historySchema = new Schema(
  {
    action: { type: String, required: true }, // PROCESSED, RECALCULATED, APPROVED, REOPENED, PAID, ADJUSTMENT_ADDED, …
    reason: String,
    by: actorSchema,
    at: { type: Date, default: Date.now },
    previousSnapshot: Schema.Types.Mixed, // kept on REOPEN
  },
  { _id: false },
);

const vdpSchema = new Schema(
  {
    providerId: { type: Schema.Types.ObjectId, ref: 'Provider', required: true },
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'VdpCycle', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'VdpPlan', default: null },
    planVersionId: { type: Schema.Types.ObjectId, default: null },
    performanceImportId: { type: Schema.Types.ObjectId, ref: 'PerformanceImport', default: null },
    status: { type: String, enum: VDP_STATUSES, default: 'DRAFT' },

    // Reviewer choices that are inputs, not results.
    adjustments: { type: [adjustmentSchema], default: [] },
    leaseWeeksCharged: dec({ default: null }), // null = all weeks in the cycle
    leaseNote: String,
    acknowledgements: { type: [acknowledgementSchema], default: [] },

    // Latest calculation (live until approval). Strings keep decimals exact.
    settings: Schema.Types.Mixed, // resolved settings with sources
    performance: Schema.Types.Mixed, // per-day rows used
    calculation: Schema.Types.Mixed, // serialised engine result
    gross: dec({ default: null }),
    net: dec({ default: null }),
    exceptions: { type: [exceptionSchema], default: [] },
    calculatedAt: Date,
    stale: { type: Boolean, default: false }, // inputs changed since calculation

    snapshot: { type: Schema.Types.Mixed, default: null }, // frozen at approval
    approvedAt: Date,
    approvedBy: actorSchema,
    // Provider approval window: closes at the end of the cycle's "Closed for Submission" date.
    providerDeadline: { type: Date, default: null },
    providerApproval: {
      method: { type: String, enum: ['PROVIDER', 'AUTO', null], default: null },
      at: Date,
      by: actorSchema,
    },
    paidAt: Date,
    paidBy: actorSchema,
    issues: { type: [issueSchema], default: [] },
    history: { type: [historySchema], default: [] },
  },
  jsonOptions,
);

vdpSchema.index({ providerId: 1, cycleId: 1 }, { unique: true });
vdpSchema.index({ status: 1, providerDeadline: 1 });

export default mongoose.model('Vdp', vdpSchema);
