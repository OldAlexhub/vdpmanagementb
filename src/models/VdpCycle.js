import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const { Schema } = mongoose;

export const CYCLE_STATUSES = ['UPCOMING', 'OPEN', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'PAID', 'CLOSED'];

const cycleSchema = new Schema(
  {
    divisionId: { type: Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    cycleStart: { type: Date, required: true },
    cycleEnd: { type: Date, required: true },
    week1Start: { type: Date, required: true },
    week1End: { type: Date, required: true },
    week2Start: { type: Date, required: true },
    week2End: { type: Date, required: true },
    submissionDate: Date,
    paymentDate: Date,
    status: { type: String, enum: CYCLE_STATUSES, default: 'UPCOMING' },
    notes: String,
  },
  jsonOptions,
);

cycleSchema.index({ divisionId: 1, cycleStart: 1 }, { unique: true });

export default mongoose.model('VdpCycle', cycleSchema);
