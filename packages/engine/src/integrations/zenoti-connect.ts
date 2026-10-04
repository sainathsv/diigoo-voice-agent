import { and, eq, sql } from "drizzle-orm";
import { audit, branches, integrations, withTenant, type AuditInput, type Integration, type Tx } from "@jenai/db";
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
 * Which JENAI branch each Zenoti centre is. A branch kept in the map stands
 * while it exists, so a clinic's correction is never undone; otherwise the
 * centre's name or code is matched. Centres not in `centres` keep their entry.
 */
export function zenotiBranchMap(
  centres: ZenotiCentre[],
  list: ReadonlyArray<{ id: string; name: string; code?: string | null }>,
  had: Record<string, unknown>,
): Record<string, string | null> {
  const match = branchMatcher(list);
  const map: Record<string, string | null> = { ...(had as Record<string, string | null>) };
  for (const c of centres) {
    const kept = typeof had[c.id] === "string" && list.some((b) => b.id === had[c.id]) ? (had[c.id] as string) : null;
    map[c.id] = kept ?? match(c.name) ?? match(c.code) ?? null;
  }
  return map;
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
    const branchMap = test.centres.length ? zenotiBranchMap(test.centres, list, had) : (had as Record<string, string | null>);
    const moved = JSON.stringify(branchMap) !== JSON.stringify(had);
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
