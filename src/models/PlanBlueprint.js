import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const planBlueprintSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    name: { type: String, required: true, trim: true },
    divisionNumber: { type: String, required: true, trim: true, index: true },
    variant: { type: String, enum: ['SIGNED_DOCUMENT', 'OPERATIONAL_WORKBOOK'], required: true },
    sourceDocument: { type: String, required: true },
    sourceChecksum: { type: String, required: true },
    effectiveFrom: String,
    effectiveTo: String,
    specification: { type: mongoose.Schema.Types.Mixed, required: true },
    processingEnabled: { type: Boolean, default: true },
    validation: {
      schemaPassed: { type: Boolean, default: false },
      boundariesPassed: { type: Boolean, default: false },
      reconciliationPassed: { type: Boolean, default: false },
      verifiedAt: Date,
    },
    status: { type: String, enum: ['DRAFT', 'APPROVED', 'RETIRED'], default: 'DRAFT' },
  },
  jsonOptions,
);

planBlueprintSchema.index({ key: 1, version: 1 }, { unique: true });

export default mongoose.model('PlanBlueprint', planBlueprintSchema);
