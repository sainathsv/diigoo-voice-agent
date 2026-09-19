import { auditEvents, outbox } from "./schema";
import type { Db, Tx } from "./client";

export interface AuditInput {
  tenantId: string | null;
  actorUserId: string | null;
  impersonatorUserId?: string | null;
  via?: "user" | "support" | "api" | "system";
  action: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** Append one audit event. Call inside the same transaction as the change it records. */
export async function audit(tx: Tx | Db, e: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: e.tenantId,
    actorUserId: e.actorUserId,
    impersonatorUserId: e.impersonatorUserId ?? null,
    via: e.via ?? (e.impersonatorUserId ? "support" : "user"),
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    summary: e.summary,
    diff: (e.diff ?? null) as never,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
}

/** Record a domain event for the relay (webhooks, jobs) in the same transaction. */
export async function emit(
  tx: Tx | Db,
  e: { tenantId: string | null; aggregate: string; aggregateId: string; eventType: string; payload?: unknown },
): Promise<void> {
  await tx.insert(outbox).values({
    tenantId: e.tenantId,
    aggregate: e.aggregate,
    aggregateId: e.aggregateId,
    eventType: e.eventType,
    payload: (e.payload ?? {}) as never,
  });
}
