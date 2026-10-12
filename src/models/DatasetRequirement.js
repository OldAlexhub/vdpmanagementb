import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const datasetRequirementSchema = new mongoose.Schema(
  {
    divisionNumber: { type: String, required: true, trim: true, index: true },
    datasetType: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    classification: {
      type: String,
      enum: ['GLOBAL_REQUIRED', 'PROVIDER_CONDITIONAL', 'OPTIONAL', 'NSM_RECONCILIATION'],
      required: true,
    },
    stage: { type: String, enum: ['REQUIRED', 'ADDITIONAL'], required: true },
    schemaVersion: { type: String, required: true, default: '1' },
    enabled: { type: Boolean, default: true },
  },
  jsonOptions,
);

datasetRequirementSchema.index({ divisionNumber: 1, datasetType: 1 }, { unique: true });

export default mongoose.model('DatasetRequirement', datasetRequirementSchema);
