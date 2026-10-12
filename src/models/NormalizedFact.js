import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

// One bounded calculation/audit fact. Source files are parsed in Node and
// discarded; Mongo stores only this normalized grain plus import metadata.
const normalizedFactSchema = new mongoose.Schema(
  {
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'PerformanceImport', required: true, index: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'VdpCycle', required: true, index: true },
    divisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true, index: true },
    datasetType: { type: String, required: true, trim: true, index: true },
    factType: {
      type: String,
      enum: ['PERFORMANCE', 'OBSERVED_WINDOW', 'FARE', 'FUEL', 'ADJUSTMENT'],
      required: true,
      index: true,
    },
    sequence: { type: Number, required: true, min: 0 },
    date: { type: String, default: null, index: true },
    route: { type: String, default: null, index: true },
    sourceIdentity: { type: String, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  jsonOptions,
);

normalizedFactSchema.index({ importId: 1, factType: 1, sequence: 1 }, { unique: true });
normalizedFactSchema.index({ cycleId: 1, datasetType: 1, factType: 1, date: 1 });

export default mongoose.model('NormalizedFact', normalizedFactSchema);
