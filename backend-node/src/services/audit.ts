import { db } from '../db/index.js';
import { toJson } from '../db/json.js';
import type { AuditEventType, MarketplaceType } from '../db/types.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('audit');

/**
 * Append-only audit trail. Port of AuditService.
 *
 * ── Fire-and-forget, deliberately ────────────────────────────────────────────
 *
 * The Java version is @Async + @Transactional(REQUIRES_NEW): the write happens
 * off the request thread, in its own transaction, so an audit failure can never
 * roll back or break the operation being audited.
 *
 * Node has no thread pool to hand this to, but the same two properties are what
 * matter and both hold here: the insert is a separate statement outside any
 * caller transaction, and every error is swallowed and logged rather than
 * propagated.
 *
 * Callers should NOT await this. `void record(...)` is the intended usage — the
 * response should not wait on the audit row. The one consequence to be aware of
 * is that an audit write in flight when the process is SIGTERM'd may be lost;
 * that is the same trade the @Async version made.
 */

export interface AuditRecordInput {
  type: AuditEventType;
  actorId?: string | null;
  actorName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  marketplaceType?: MarketplaceType | null;
  success?: boolean;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export function record(input: AuditRecordInput): void {
  const {
    type,
    actorId = null,
    actorName = null,
    entityType = null,
    entityId = null,
    marketplaceType = null,
    success = true,
    errorMessage = null,
    metadata = {},
  } = input;

  void db
    .insertInto('audit_events')
    .values({
      event_type: type,
      actor_id: actorId,
      actor_name: actorName,
      entity_type: entityType,
      entity_id: entityId,
      marketplace_type: marketplaceType,
      success,
      error_message: errorMessage,
      metadata: toJson(metadata),
    })
    .execute()
    .catch((err: unknown) => {
      // An audit failure must never crash the calling operation.
      log.error({ err, type, entityType, entityId }, 'Failed to record audit event');
    });
}

/** Convenience wrapper matching AuditService.recordMarketplaceEvent. */
export function recordMarketplaceEvent(
  type: AuditEventType,
  marketplaceType: MarketplaceType | null,
  actorId: string | null,
  entityType: string,
  entityId: string,
  success: boolean,
  errorMessage: string | null,
  metadata: Record<string, unknown> = {},
): void {
  record({ type, marketplaceType, actorId, entityType, entityId, success, errorMessage, metadata });
}
