import mongoose from 'mongoose';
import { actorSchema, dec, jsonOptions } from './common.js';

const matchResolutionSchema = new mongoose.Schema(
  {
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'VdpCycle', required: true, index: true },
    divisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    sourceService: { type: String, required: true, trim: true },
    sourceIdentity: { type: String, required: true, trim: true },
    sourceName: { type: String, trim: true },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
    operatorId: { type: String, default: null },
    status: { type: String, enum: ['MATCHED', 'SET_ASIDE'], required: true },
    method: { type: String, enum: ['STABLE_ID', 'EXACT_NAME', 'SMART_NAME', 'PREVIOUSLY_APPROVED', 'MANUAL', 'SET_ASIDE'], required: true },
    confidence: dec({ default: null }),
    reason: { type: String, trim: true, default: null },
    resolvedBy: actorSchema,
    resolvedAt: { type: Date, default: Date.now },
  },
  jsonOptions,
);

matchResolutionSchema.index({ cycleId: 1, sourceService: 1, sourceIdentity: 1 }, { unique: true });

export default mongoose.model('MatchResolution', matchResolutionSchema);
