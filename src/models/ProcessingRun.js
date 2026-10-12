import mongoose from 'mongoose';
import { actorSchema, jsonOptions } from './common.js';

const processingRunSchema = new mongoose.Schema(
  {
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'VdpCycle', required: true, unique: true, index: true },
    divisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    processingDivisionIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Division', default: [] },
    status: {
      type: String,
      enum: ['INTAKE', 'READY', 'PROCESSING', 'EXCEPTIONS', 'REVIEW', 'COMPLETE', 'FAILED', 'ARCHIVED'],
      default: 'INTAKE',
      index: true,
    },
    currentSection: {
      type: String,
      enum: ['DIVISION', 'REQUIRED_DATA', 'ADDITIONAL_DATA', 'VALIDATION', 'RESULTS'],
      default: 'DIVISION',
    },
    readiness: mongoose.Schema.Types.Mixed,
    lastResult: mongoose.Schema.Types.Mixed,
    lastError: mongoose.Schema.Types.Mixed,
    createdBy: actorSchema,
    lastOpenedBy: actorSchema,
    lastOpenedAt: { type: Date, default: Date.now },
    processedBy: actorSchema,
    processedAt: Date,
    archivedAt: Date,
  },
  jsonOptions,
);

processingRunSchema.index({ status: 1, lastOpenedAt: -1 });

export default mongoose.model('ProcessingRun', processingRunSchema);
