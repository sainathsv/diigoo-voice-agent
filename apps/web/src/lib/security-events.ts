import "server-only";
import { appDb, securityEvents, type SecurityEventKind } from "@jenai/db";

export interface SecurityEventInput {
  email?: string | null;
  userId?: string | null;
  tenantId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append one sign-in or access event for the detector (security_events is
 * write-only for the app role). Never throws: a logging fault must not lock
 * people out, but it is reported so a silent gap cannot go unnoticed.
 */
export async function recordSecurityEvent(kind: SecurityEventKind, e: SecurityEventInput): Promise<void> {
  try {
    await appDb().insert(securityEvents).values({
      kind,
      email: e.email ? e.email.trim().toLowerCase().slice(0, 320) : null,
      userId: e.userId ?? null,
      tenantId: e.tenantId ?? null,
      detail: (e.detail ?? null) as never,
      ip: e.ip ?? null,
      userAgent: e.userAgent ? e.userAgent.slice(0, 400) : null,
    });
  } catch (err) {
    console.error(`[security] event not recorded: ${kind}: ${(err as Error).message}`);
  }
}
