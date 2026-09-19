import "server-only";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { organizations, platformDb, securityAlerts, securityDetectorState, securityEvents, user } from "@jenai/db";

// Console reads only. Every caller has passed requirePlatform("platform:security.view") first.

const SEVERITY_ORDER = sql`case ${securityAlerts.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

export async function liveAlerts() {
  return platformDb()
    .select({ a: securityAlerts, orgName: organizations.name, handler: user.name })
    .from(securityAlerts)
    .leftJoin(organizations, eq(organizations.id, securityAlerts.tenantId))
    .leftJoin(user, eq(user.id, securityAlerts.handledBy))
    .where(inArray(securityAlerts.status, ["open", "acknowledged"]))
    .orderBy(SEVERITY_ORDER, desc(securityAlerts.lastSeen))
    .limit(200);
}

export async function closedAlerts() {
  return platformDb()
    .select({ a: securityAlerts, orgName: organizations.name, handler: user.name })
    .from(securityAlerts)
    .leftJoin(organizations, eq(organizations.id, securityAlerts.tenantId))
    .leftJoin(user, eq(user.id, securityAlerts.handledBy))
    .where(inArray(securityAlerts.status, ["resolved", "false_positive"]))
    .orderBy(desc(securityAlerts.handledAt))
    .limit(30);
}

export async function signInSummary() {
  const [r] = await platformDb()
    .select({
      ok: sql<number>`count(*) filter (where ${securityEvents.kind} = 'signin_ok')::int`,
      failed: sql<number>`count(*) filter (where ${securityEvents.kind} = 'signin_failed')::int`,
      locked: sql<number>`count(*) filter (where ${securityEvents.kind} = 'signin_locked')::int`,
      denied: sql<number>`count(*) filter (where ${securityEvents.kind} = 'access_denied')::int`,
    })
    .from(securityEvents)
    .where(sql`${securityEvents.createdAt} > now() - interval '24 hours'`);
  return r!;
}

export async function recentProblems() {
  return platformDb()
    .select({ e: securityEvents, userEmail: user.email, orgName: organizations.name })
    .from(securityEvents)
    .leftJoin(user, eq(user.id, securityEvents.userId))
    .leftJoin(organizations, eq(organizations.id, securityEvents.tenantId))
    .where(inArray(securityEvents.kind, ["signin_failed", "signin_locked", "access_denied", "mfa_failed"]))
    .orderBy(desc(securityEvents.id))
    .limit(60);
}

/** Last integrity check, written by the worker (hourly) or the "Check now" button. */
export async function lastIntegrityCheck() {
  const rows = await platformDb()
    .select()
    .from(securityDetectorState)
    .where(inArray(securityDetectorState.name, ["audit_verified_at", "audit_broken_chains", "audit_chains"]));
  const get = (n: string) => rows.find((r) => r.name === n);
  const at = get("audit_verified_at");
  return at ? { at: new Date(at.lastId), broken: get("audit_broken_chains")?.lastId ?? 0, chains: get("audit_chains")?.lastId ?? 0 } : null;
}

export async function detectorHeartbeat() {
  const [r] = await platformDb().select().from(securityDetectorState).where(eq(securityDetectorState.name, "detector_heartbeat"));
  return r ? new Date(r.lastId) : null;
}
