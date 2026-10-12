import mongoose from 'mongoose';
import { actorSchema, jsonOptions } from './common.js';

const auditEventSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true, index: true },
    entityType: { type: String, required: true, trim: true, index: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    entityLabel: { type: String, trim: true, default: null },
    reason: { type: String, trim: true, default: null },
    actor: actorSchema,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    metadata: mongoose.Schema.Types.Mixed,
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  jsonOptions,
);

auditEventSchema.index({ entityType: 1, entityId: 1, occurredAt: -1 });

export default mongoose.model('AuditEvent', auditEventSchema);
