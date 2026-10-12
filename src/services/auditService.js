import AuditEvent from '../models/AuditEvent.js';
import { actor } from './errors.js';

export async function recordAudit({ action, entityType, entityId, entityLabel, reason, user, before, after, metadata }) {
  return AuditEvent.create({
    action,
    entityType,
    entityId: entityId || null,
    entityLabel: entityLabel || null,
    reason: reason || null,
    actor: actor(user),
    before,
    after,
    metadata,
  });
}
