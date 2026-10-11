import mongoose from 'mongoose';
import { dec, jsonOptions } from './common.js';

const liftLeaseOptionSchema = new mongoose.Schema(
  {
    divisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    name: { type: String, required: true, trim: true },
    amount: dec({ default: null }),
    frequency: { type: String, enum: ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'], required: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  },
  jsonOptions,
);

liftLeaseOptionSchema.index({ divisionId: 1, name: 1 });

export default mongoose.model('LiftLeaseOption', liftLeaseOptionSchema);
