import mongoose from 'mongoose';
import { actorSchema, jsonOptions } from './common.js';

// Metadata-only import ledger. Calculation facts remain normalized by their
// source adapter; source workbooks are never stored in MongoDB.
const datasetImportSchema = new mongoose.Schema(
  {
    processingRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessingRun', required: true, index: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'VdpCycle', required: true, index: true },
    divisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    datasetType: { type: String, required: true, trim: true, index: true },
    sourceImportId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerformanceImport', required: true, unique: true },
    filename: { type: String, required: true },
    checksum: { type: String, required: true, index: true },
    fileSize: Number,
    schemaVersion: { type: String, default: '1' },
    parserVersion: { type: String, default: '1' },
    dateCoverage: { from: String, to: String },
    status: { type: String, enum: ['STAGED', 'ACTIVE', 'SUPERSEDED', 'INVALID'], default: 'ACTIVE' },
    supersedesId: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetImport', default: null },
    supersededById: { type: mongoose.Schema.Types.ObjectId, ref: 'DatasetImport', default: null },
    uploadedBy: actorSchema,
    activatedAt: Date,
  },
  jsonOptions,
);

datasetImportSchema.index({ processingRunId: 1, datasetType: 1, status: 1 });
datasetImportSchema.index({ processingRunId: 1, checksum: 1 });

export default mongoose.model('DatasetImport', datasetImportSchema);
