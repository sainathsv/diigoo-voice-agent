import { and, eq, sql } from "drizzle-orm";
import { audit, branches, clinicAppointments, integrations, visits, withTenant, type AuditInput, type Integration, type Tx } from "@jenai/db";
import { branchMatcher } from "../visits-import";
import { credentialsOf, sealCredentials } from "./queue";
import type { ConnectorContext } from "./types";
import { testZenoti, type ZenotiCentre, type ZenotiClock, type ZenotiTestResult } from "./zenoti";

/**
 * Connecting a clinic's Zenoti: the key saved, sealed, on the clinic's one
 * Zenoti connection, then tested for what it may read. Read only, like all
 * of JENAI's Zenoti: the test reads the list of centres and makes one small
 * read of each kind, and nothing is ever written to Zenoti.
 */

/**
 * What a Zenoti backend app hands out: its "API Key", and the "Application
 * ID" and secret it was made with (docs.zenoti.com/docs/create-the-backend-app-
 * and-generate-a-new-api-key-1). Only the API key is used; the other two are
 * kept for Zenoti's token sign-in, should a client's setup need it.
 */
export interface ZenotiCredentials {
  api_key: string;
  app_id?: string;
  app_secret?: string;
}

/** A key that cannot be used as it is. The message names the field, never what is in it. */
export class ZenotiCredentialsError extends Error {
  override name = "ZenotiCredentialsError";
}

/** Printable characters and no spaces: the key goes after "apikey " in a header, where a stray line break would split it. */
const TOKEN = /^[\x21-\x7e]+$/;
const MAX_LENGTH = 500;
const SHAPE = 'It should look like {"api_key": "..."}, with "app_id" and "app_secret" too if you have them.';

/** The credentials in what a clinic handed over, checked. Anything else in it is left out. */
export function zenotiCredentials(raw: unknown): ZenotiCredentials {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ZenotiCredentialsError(`The Zenoti key is not in the right shape. ${SHAPE}`);
  const o = raw as Record<string, unknown>;
  const field = (name: keyof ZenotiCredentials): string | undefined => {
    const v = o[name];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return undefined;
    if (typeof v !== "string") throw new ZenotiCredentialsError(`"${name}" should be text in quotes. ${SHAPE}`);
    const s = v.trim();
    if (s.length > MAX_LENGTH || !TOKEN.test(s)) throw new ZenotiCredentialsError(`"${name}" has spaces or characters Zenoti never puts in one. Copy it again from Zenoti.`);
    return s;
  };
  const api_key = field("api_key");
  if (!api_key) throw new ZenotiCredentialsError(`There is no "api_key". ${SHAPE}`);
  const app_id = field("app_id");
  const app_secret = field("app_secret");
  return { api_key, ...(app_id ? { app_id } : {}), ...(app_secret ? { app_secret } : {}) };
}

/**
 * Saves a Zenoti key on the client's Zenoti connection, making it if there is
 * none: one Zenoti per client, so connecting again replaces the key and keeps
 * the rest (the name, the centres chosen, the branch map, how far back to
 * read, where each centre got to). What the old key was found to read is
 * dropped, because it says nothing about the new one; the sync checks again
 * before reading. It stays a draft until a test shows the key works.
 */
export async function saveZenotiConnection(
  tx: Tx,
  tenantId: string,
  input: { credentials: ZenotiCredentials; createdBy?: string | null },
): Promise<{ integration: Integration; reconnected: boolean }> {
  const [existing] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.kind, "zenoti")))
    .orderBy(integrations.createdAt)
    .limit(1);
  const creds = Object.fromEntries(Object.entries(zenotiCredentials(input.credentials)).filter(([, v]) => v)) as Record<string, string>;
  const row = {
    name: existing?.name ?? "Zenoti",
    status: "draft" as const,
    direction: "in",
    credentials: sealCredentials(tenantId, creds),
    lastError: null,
    lastErrorAt: null,
    updatedAt: new Date(),
  };
  if (existing) {
    // Removed in the statement itself, so a setting a running sync saves meanwhile is not lost.
    const [i] = await tx
      .update(integrations)
      .set({ ...row, config: sql`${integrations.config} - 'access'` })
      .where(and(eq(integrations.tenantId, tenantId), eq(integrations.id, existing.id)))
      .returning();
    return { integration: i!, reconnected: true };
  }
  const [i] = await tx.insert(integrations).values({ tenantId, kind: "zenoti", events: [], config: {}, createdBy: input.createdBy ?? null, ...row }).returning();
  return { integration: i!, reconnected: false };
}

/**
 * How a Zenoti read keeps what it learnt on the connection: merged into the
 * config as it is in the database at that moment, in a transaction of its
 * own, so nothing saved meanwhile is lost and no transaction stays open while
 * Zenoti is asked.
 */
export function zenotiSaver(tenantId: string, integrationId: string): ConnectorContext["save"] {
  return async (patch) => {
    await withTenant(tenantId, (tx) =>
      tx
        .update(integrations)
        .set({
          ...(patch.credentials ? { credentials: sealCredentials(tenantId, patch.credentials) } : {}),
          ...(patch.config ? { config: sql`${integrations.config} || ${JSON.stringify(patch.config)}::jsonb` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integrationId)),
    );
  };
}

/**
 * Which JENAI branch each Zenoti centre is (config.branchMap). A branch the
 * clinic chose for a centre (config.branchPins names those centres) stands
 * while it exists, so a correction is never undone; "no branch" chosen
 * stands too. Every other centre is matched again by name or code each
 * time, so a match made before a better branch existed is not frozen.
 * Centres not in `centres` keep their entry.
 */
export function zenotiBranchMap(
  centres: ZenotiCentre[],
  list: ReadonlyArray<{ id: string; name: string; code?: string | null }>,
  had: Record<string, unknown>,
  pins: Record<string, unknown> = {},
): Record<string, string | null> {
  const match = branchMatcher(list);
  const map: Record<string, string | null> = { ...(had as Record<string, string | null>) };
  for (const c of centres) {
    const was = had[c.id];
    const chosen = pins[c.id] === true && (was === null || (typeof was === "string" && list.some((b) => b.id === was)));
    map[c.id] = chosen ? (was as string | null) : (match(c.name) ?? match(c.code) ?? null);
  }
  return map;
}

/**
 * Puts a centre's new branch on what is stored from it: its bookings and
 * visits. A row read later gets it anyway; this is for the ones already there.
 */
export async function applyBranchMap(tx: Tx, integrationId: string, map: Record<string, string | null>, had: Record<string, unknown>): Promise<number> {
  let moved = 0;
  for (const [centre, branchId] of Object.entries(map)) {
    if ((had[centre] ?? null) === branchId) continue;
    const a = await tx
      .update(clinicAppointments)
      .set({ branchId })
      .where(and(eq(clinicAppointments.integrationId, integrationId), eq(clinicAppointments.centreRef, centre)))
      .returning({ id: clinicAppointments.id });
    const v = await tx
      .update(visits)
      .set({ branchId })
      .where(and(eq(visits.integrationId, integrationId), eq(visits.centreRef, centre)))
      .returning({ id: visits.id });
    moved += a.length + v.length;
  }
  return moved;
}

export interface ZenotiBranchChoice {
  /** The connection as it is after the change. */
  integration: Integration;
  centre: ZenotiCentre;
  /** The branch the centre is now, null for none. */
  branchId: string | null;
  branchName: string | null;
  /** Chosen by the clinic (true), or matched by name again (false). */
  chosen: boolean;
  /** Bookings and visits already stored that moved to it. */
  moved: number;
}

/**
 * Sets which JENAI branch one Zenoti centre is, as the clinic says: a branch,
 * no branch (null), or back to matching by name ("match"). The choice is kept
 * (config.branchPins) so no later check undoes it, put on what is stored from
 * that centre, and audited.
 */
export async function chooseZenotiBranch(
  tx: Tx,
  tenantId: string,
  integrationId: string,
  input: { centre: string; branch: string | null | "match"; actor?: ZenotiActor },
): Promise<ZenotiBranchChoice> {
  const [i] = await tx.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!i || i.kind !== "zenoti") throw new Error("This client has no such Zenoti connection.");
  const want = input.centre.trim().toLowerCase();
  const centres = (Array.isArray(i.config.centres) ? i.config.centres : []).map(obj).flatMap((c) =>
    typeof c.id === "string" ? [{ id: c.id, name: typeof c.name === "string" ? c.name : null, code: typeof c.code === "string" ? c.code : null, phoneCode: null }] : [],
  );
  const centre = centres.find((c) => c.id.toLowerCase() === want || c.code?.toLowerCase() === want);
  if (!centre) throw new ZenotiBranchError(`No centre "${input.centre}" on this Zenoti connection. Test it first, then name a centre by its code or id.`);
  const list = await tx.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches);
  let branchId: string | null = null;
  if (input.branch !== null && input.branch !== "match") {
    const name = input.branch.trim().toLowerCase();
    const hit = list.filter((b) => b.name.trim().toLowerCase() === name || b.code?.trim().toLowerCase() === name);
    if (hit.length !== 1) throw new ZenotiBranchError(hit.length ? `More than one branch is called "${input.branch}".` : `No branch called "${input.branch}" in this workspace.`);
    branchId = hit[0]!.id;
  }
  const had = obj(i.config.branchMap);
  const pins = { ...obj(i.config.branchPins) };
  if (input.branch === "match") delete pins[centre.id];
  else pins[centre.id] = true;
  const map = zenotiBranchMap([centre], list, input.branch === "match" ? had : { ...had, [centre.id]: branchId }, pins);
  const moved = await applyBranchMap(tx, i.id, { [centre.id]: map[centre.id] ?? null }, had);
  const [after] = await tx
    .update(integrations)
    .set({ config: sql`${integrations.config} || ${JSON.stringify({ branchMap: { ...had, ...map }, branchPins: pins })}::jsonb`, updatedAt: new Date() })
    .where(eq(integrations.id, i.id))
    .returning();
  const now = map[centre.id] ?? null;
  const branchName = list.find((b) => b.id === now)?.name ?? null;
  const label = [centre.name, centre.code].filter(Boolean).join(", ") || centre.id;
  await audit(tx, {
    ...input.actor,
    actorUserId: input.actor?.actorUserId ?? null,
    via: input.actor?.via ?? "system",
    tenantId,
    action: "integration.updated",
    targetType: "integration",
    targetId: i.id,
    summary: `Zenoti centre ${label} ${input.branch === "match" ? `is matched by name again: ${branchName ?? "no branch"}` : `is now ${branchName ? `the ${branchName} branch` : "no branch"}, as the clinic chose`}`,
    diff: { centre: centre.id, branchId: { from: had[centre.id] ?? null, to: now }, chosen: input.branch !== "match", moved },
  });
  return { integration: after!, centre, branchId: now, branchName, chosen: input.branch !== "match", moved };
}

/** A centre or branch named for the branch map that cannot be used. The message names what was asked for, never a guest. */
export class ZenotiBranchError extends Error {
  override name = "ZenotiBranchError";
}

export interface ZenotiConnectionCheck {
  /** The connection as it is after the test. */
  integration: Integration;
  test: ZenotiTestResult;
  /** Connected: the centres were read and services done can be read one way or another. */
  ok: boolean;
  /** Zenoti centre id to JENAI branch id, null where no branch matched. */
  branchMap: Record<string, string | null>;
  /** JENAI branch names by id, to show the map. */
  branchNames: Record<string, string>;
}

/** Who asked for the test, for the audit trail. The command line and the worker are the system. */
export type ZenotiActor = Pick<AuditInput, "actorUserId" | "impersonatorUserId" | "via" | "ip" | "userAgent">;

/**
 * Tests a Zenoti connection and records the answer on it: what the key may
 * read and the best way to see services done (config.access), the centres
 * (config.centres), each centre's JENAI branch (config.branchMap), and the
 * status, connected only when the centres were read and services done can be
 * read, otherwise error with the reason in plain words. A paused connection
 * stays paused: the test only says whether it would work. Zenoti is asked
 * with no transaction open; the answer is stored, and audited, in one.
 */
export async function checkZenotiConnection(
  tenantId: string,
  integrationId: string,
  opts: { fetchImpl?: typeof fetch; clock?: ZenotiClock; actor?: ZenotiActor } = {},
): Promise<ZenotiConnectionCheck> {
  const [i] = await withTenant(tenantId, (tx) => tx.select().from(integrations).where(eq(integrations.id, integrationId)));
  if (!i || i.kind !== "zenoti") throw new Error("This client has no such Zenoti connection.");
  const test = await testZenoti({ integration: i, credentials: credentialsOf(i), fetch: opts.fetchImpl ?? fetch, save: zenotiSaver(tenantId, i.id) }, opts.clock);
  const ok = test.ok && test.centres.length > 0 && test.path !== null;

  return withTenant(tenantId, async (tx) => {
    const list = await tx.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches);
    const [now] = await tx.select().from(integrations).where(eq(integrations.id, i.id));
    if (!now) throw new Error("The Zenoti connection was removed while it was being tested.");
    const had = obj(now.config.branchMap);
    // Centres that could not be read leave the map as it was.
    const branchMap = test.centres.length ? zenotiBranchMap(test.centres, list, had, obj(now.config.branchPins)) : (had as Record<string, string | null>);
    const moved = JSON.stringify(branchMap) !== JSON.stringify(had);
    if (moved) await applyBranchMap(tx, i.id, branchMap, had);
    const [after] = await tx
      .update(integrations)
      .set({
        status: now.status === "paused" ? "paused" : ok ? "connected" : "error",
        ...(ok ? { lastOkAt: new Date(), lastError: null } : { lastError: test.message, lastErrorAt: new Date() }),
        ...(moved ? { config: sql`${integrations.config} || ${JSON.stringify({ branchMap })}::jsonb` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, i.id))
      .returning();
    await audit(tx, {
      ...opts.actor,
      actorUserId: opts.actor?.actorUserId ?? null,
      via: opts.actor?.via ?? "system",
      tenantId,
      action: "integration.tested",
      targetType: "integration",
      targetId: i.id,
      summary: `Tested ${i.name}: ${ok ? "connected" : "not working yet"}, ${test.centres.length} centre${test.centres.length === 1 ? "" : "s"}, services done ${test.path ? `from ${test.path.replace("_", " ")}` : "not readable"}`,
      diff: { ok, path: test.path, capabilities: test.capabilities, centres: test.centres.length, branchMap },
    });
    return { integration: after!, test, ok, branchMap, branchNames: Object.fromEntries(list.map((b) => [b.id, b.name])) };
  });
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
