/**
 * What `pnpm --filter @jenai/db zenoti ...` does, kept apart from reading the
 * command line so tests can run each command against a fake Zenoti.
 *
 * The key is read from a JSON file only, never from an argument or the
 * environment, so it stays out of shell history, the process list and CI
 * logs. Nothing here writes to Zenoti, dials, or makes campaign targets.
 * Output carries counts, dates, and centre and branch names and codes; never
 * a key, a guest's name or a number.
 */
import { readFile, stat } from "node:fs/promises";
import { eq, gte, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  PLAN_JOURNEYS,
  ZENOTI_MAX_BACKFILL_DAYS,
  ZENOTI_SYNC_CALLS,
  ZenotiCredentialsError,
  checkZenotiConnection,
  credentialsOf,
  saveZenotiConnection,
  syncZenoti,
  zenotiBackfillDays,
  zenotiCredentials,
  type PlanJourney,
  type ZenotiCapabilities,
  type ZenotiClock,
  type ZenotiConnectionCheck,
  type ZenotiCredentials,
  type ZenotiPath,
  type ZenotiSyncResult,
} from "@jenai/engine";
import { audit, clinicAppointments, externalPeople, integrations, organizations, packageBalances, platformDb, visits, withTenant, type Integration } from "../index";

export interface ZenotiCommandDeps {
  /** Where each line of output goes: the terminal unless a test says otherwise. */
  print?: (line: string) => void;
  /** For tests: a fake Zenoti. */
  fetchImpl?: typeof fetch;
  /** For tests: pacing and Zenoti's waits pass on this clock. */
  clock?: ZenotiClock;
  /** For tests: today. */
  now?: Date;
}

/** A mistake whoever runs the command can put right: said in plain words, without a stack. */
export class ZenotiCommandError extends Error {
  override name = "ZenotiCommandError";
}

/** A key file holds three short values; anything this big is the wrong file. */
const KEY_FILE_MAX_BYTES = 16 * 1024;
const SHAPE = 'It should hold {"api_key": "..."}, with "app_id" and "app_secret" too if you have them.';
/** About ten minutes of Zenoti at 40 calls a minute, well inside the 15 minute pull lease. */
export const ZENOTI_COMMAND_MAX_BUDGET = 400;

/**
 * The Zenoti key in a JSON file. What is wrong with a file is said without
 * quoting it: the parser's own message would show part of the key.
 */
export async function readZenotiKeyFile(path: string): Promise<{ credentials: ZenotiCredentials; openToOthers: boolean }> {
  if (!path) throw new ZenotiCommandError(`need --file <path to the key file>. ${SHAPE}`);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ZenotiCommandError(`There is no key file at ${path}.`);
  if (info.size > KEY_FILE_MAX_BYTES) throw new ZenotiCommandError(`${path} is far larger than a key file. ${SHAPE}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ZenotiCommandError(`${path} is not JSON. ${SHAPE}`);
  }
  try {
    // Other accounts on this machine can read a file whose group or other bits are set.
    return { credentials: zenotiCredentials(raw), openToOthers: (info.mode & 0o077) !== 0 };
  } catch (e) {
    if (e instanceof ZenotiCredentialsError) throw new ZenotiCommandError(`The key file: ${e.message}`);
    throw e;
  }
}

/** Stores the key in the file on the client's Zenoti connection, tests it, and says what it may read. */
export async function connectCommand(input: { tenant: string; file: string }, deps: ZenotiCommandDeps = {}): Promise<ZenotiConnectionCheck> {
  const org = await clientOf(input.tenant);
  const { credentials, openToOthers } = await readZenotiKeyFile(input.file);
  const say = printer(deps, credentials);
  const saved = await withTenant(org.id, async (tx) => {
    const s = await saveZenotiConnection(tx, org.id, { credentials });
    await audit(tx, {
      tenantId: org.id,
      actorUserId: null,
      via: "system",
      action: s.reconnected ? "integration.reconnected" : "integration.connected",
      targetType: "integration",
      targetId: s.integration.id,
      summary: `${s.reconnected ? "Reconnected" : "Connected"} ${s.integration.name} (zenoti, read only) from the command line; the key is sealed`,
      // Which values the file gave, never the values.
      diff: { kind: "zenoti", given: Object.keys(credentials) },
    });
    return s;
  });

  say("");
  say(`${org.name}: Zenoti key ${saved.reconnected ? "replaced on the existing connection, its settings kept" : "stored on a new connection"}, sealed.`);
  const check = await checkZenotiConnection(org.id, saved.integration.id, { fetchImpl: deps.fetchImpl, clock: deps.clock });
  showCheck(check, say);
  if (check.ok) say(`  Next: zenoti sync --tenant ${org.slug} reads it into JENAI once.`);
  say(`  Delete ${input.file} now: JENAI keeps the key sealed and never needs the file again.`);
  if (openToOthers) say("  Until then, other accounts on this machine can read it (chmod 600 it, or delete it).");
  say("");
  return check;
}

/** Tests the client's Zenoti connection again and says what it may read. */
export async function testCommand(input: { tenant: string }, deps: ZenotiCommandDeps = {}): Promise<ZenotiConnectionCheck> {
  const org = await clientOf(input.tenant);
  const i = await connectionOf(org);
  const say = printer(deps, openedCredentials(i));
  say("");
  say(`${org.name}: testing the Zenoti connection`);
  const check = await checkZenotiConnection(org.id, i.id, { fetchImpl: deps.fetchImpl, clock: deps.clock });
  showCheck(check, say);
  say("");
  return check;
}

/** Reads the client's Zenoti once, within a call budget, and says what it stored and how the call plan came out. */
export async function syncCommand(input: { tenant: string; days?: string; budget?: string }, deps: ZenotiCommandDeps = {}): Promise<ZenotiSyncResult> {
  const budget = wholeNumber(input.budget, "--budget", 1, ZENOTI_COMMAND_MAX_BUDGET) ?? ZENOTI_SYNC_CALLS;
  const days = wholeNumber(input.days, "--days", 1, ZENOTI_MAX_BACKFILL_DAYS);
  const org = await clientOf(input.tenant);
  const i = await connectionOf(org);
  const say = printer(deps, openedCredentials(i));

  say("");
  say(`${org.name}: reading Zenoti, at most ${budget} calls`);
  const had = zenotiBackfillDays(i.config);
  if (days !== null && days > had) {
    await withTenant(org.id, async (tx) => {
      await tx
        .update(integrations)
        .set({ config: sql`${integrations.config} || ${JSON.stringify({ backfillDays: days })}::jsonb`, updatedAt: new Date() })
        .where(eq(integrations.id, i.id));
      await audit(tx, {
        tenantId: org.id,
        actorUserId: null,
        via: "system",
        action: "integration.updated",
        targetType: "integration",
        targetId: i.id,
        summary: `${i.name} now reads ${days} days back (was ${had}), set from the command line`,
        diff: { backfillDays: { from: had, to: days } },
      });
    });
    say(`  now reads ${days} days back, was ${had}: the days added are read, newest first, from this run on`);
  } else if (days !== null) {
    say(`  already reads ${had} days back; --days only widens that, so it stays`);
  }

  const r = await syncZenoti(org.id, i.id, { callBudget: budget, now: deps.now, fetchImpl: deps.fetchImpl, clock: deps.clock });
  if (!r.ran) {
    say("  Another run is reading this connection now, so nothing was read. Try again in a few minutes.");
    say("");
    return r;
  }

  say(`  services done from  ${r.path ? PATH_TEXT[r.path] : "nowhere yet"}`);
  say(`  calls               ${r.calls} of ${r.budget}${r.tested ? ", the first ones checking what the key may read" : ""}`);
  for (const c of r.centres) {
    const stored = c.cursor ? `stored ${c.from ? `from ${c.from} ` : ""}through ${c.cursor}` : "nothing stored yet";
    say(`  centre              ${centreName(c.name, null)}: ${count(c.spans, "span")} of up to 7 days read, ${stored}, ${count(c.daysLeft, "day")} left`);
  }
  const b = r.bookings;
  const v = r.visits;
  const p = r.packages;
  say("  this run");
  say(`    clinic_appointments  ${b.read} read, ${b.changed} new or changed, ${b.removed} removed`);
  say(`    visits               ${v.read} read, ${v.added} added, ${v.updated} updated, ${v.merged} folded into a visit JENAI had, ${v.removed} removed, ${v.numbered} given a phone number`);
  say(`    external_people      ${count(r.guests.read, "guest profile")} read, ${r.guests.left} still due`);
  say(`    package_balances     ${count(p.guests, "guest's packages", "guests' packages")} read, ${count(p.rows, "row")} stored, ${count(p.sessions, "visit")} given session counts, ${count(p.left, "guest")} still due`);

  const held = await heldFor(org.id, i.id, deps.now ?? new Date());
  say("  held from this connection");
  say(`    clinic_appointments  ${held.bookings} (${held.coming} still to come)`);
  say(`    visits               ${held.visits} (${held.noPhone} waiting for a phone number)`);
  say(`    external_people      ${held.people} (${held.withPhone} with a phone number, ${count(held.profiles, "profile")} read, ${held.marketing} agreed to marketing SMS)`);
  say(`    package_balances     ${held.packages} (${held.active} active)`);
  if (r.left.length) say(`  left for next time   ${r.left.join(", ")}`);
  if (r.error) say(`  PROBLEM: ${r.error}`);

  if (r.plan) {
    const x = r.plan.byVerdict;
    say("");
    say(`  call plan  ${r.plan.people} people: ${x.call_now} to call now, ${x.scheduled} scheduled, ${x.waiting} waiting for another call, ${x.kept_out} kept out`);
    for (const j of Object.keys(PLAN_JOURNEYS) as PlanJourney[]) {
      const n = r.plan.byJourney[j];
      if (n) say(`    ${j.padEnd(20)} ${Object.entries(n).map(([k, c]) => `${c} ${k.replace("_", " ")}`).join(", ")}`);
    }
    const w = r.plan.waitingForPhone;
    if (w) say(`    ${w} ${w === 1 ? "visit" : "visits"} from a connected system waiting for a phone number, not planned yet`);
    const m = r.plan.marketingConsent;
    if (m) say(`    ${m} ${m === 1 ? "person has" : "people have"} agreed to marketing SMS in their front desk system (a count only: no call is planned on it)`);
  }
  say("  Nothing was dialled, and nothing was written to Zenoti.");
  say("");
  return r;
}

// ---------------------------------------------------------------- showing a test

const CAPABILITIES: Array<[keyof ZenotiCapabilities, string]> = [
  ["appointments", "appointments"],
  ["guestDetails", "guest details"],
  ["guestPackages", "guests' packages"],
  ["salesAccrual", "sales accrual report"],
  ["salesReport", "older sales report"],
];

const PATH_TEXT: Record<ZenotiPath, string> = {
  appointments: "appointments (with each patient's mobile)",
  sales_accrual: "the sales accrual report",
  sales_report: "Zenoti's older sales report",
};

function showCheck(check: ZenotiConnectionCheck, say: (line: string) => void): void {
  const t = check.test;
  const status = check.integration.status;
  const said = t.advice.length && t.message.endsWith(t.advice.join(" ")) ? t.message.slice(0, -t.advice.join(" ").length).trim() : t.message;
  if (status === "paused") say(`  PAUSED, and kept paused: the key ${check.ok ? "works" : "does not work yet"}.`);
  else say(check.ok ? "  CONNECTED" : "  NOT WORKING YET");
  if (said) say(`  ${said}`);
  if (t.centres.length) {
    say("  centres");
    for (const c of t.centres) {
      const b = check.branchMap[c.id];
      say(`    ${centreName(c.name, c.code)}  ${b ? `is JENAI's ${check.branchNames[b] ?? "branch"} branch` : "matches no JENAI branch: what is read there is kept without a branch"}`);
    }
    say("  what the key may read");
    for (const [k, label] of CAPABILITIES) {
      const v = t.capabilities[k];
      say(`    ${label.padEnd(22)} ${v === true ? "allowed" : v === false ? "not allowed" : "no answer from Zenoti"}`);
    }
    say(`  services done from  ${t.path ? PATH_TEXT[t.path] : "nowhere: the key may read none of the ways"}`);
  }
  if (t.advice.length) {
    say("  what to do");
    for (const a of t.advice) say(`    - ${a}`);
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const centreName = (name: string | null, code: string | null) => (name && code ? `${name} (${code})` : (name ?? code ?? "a centre with no name"));

// ---------------------------------------------------------------- small things

/**
 * Prints a line, with any credential in it blanked out. None should ever be:
 * every message is built from counts and Zenoti's answers, not the request.
 * This makes sure of it.
 */
function printer(deps: ZenotiCommandDeps, credentials: Partial<ZenotiCredentials>): (line: string) => void {
  const print = deps.print ?? ((line: string) => console.log(line));
  const secrets = Object.values(credentials).filter((s): s is string => typeof s === "string" && s.length >= 4);
  return (line) => print(secrets.reduce((l, s) => l.split(s).join("[key]"), line));
}

/** The stored credentials, only to keep them out of the output. One that will not open is reported by the command itself. */
function openedCredentials(i: Integration): Record<string, string> {
  try {
    return credentialsOf(i);
  } catch {
    return {};
  }
}

async function clientOf(slug: string) {
  if (!slug) throw new ZenotiCommandError("need --tenant <address>");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org || org.kind !== "client") throw new ZenotiCommandError(`No client with the address "${slug}".`);
  return org;
}

async function connectionOf(org: { id: string; name: string; slug: string }): Promise<Integration> {
  const [i] = await withTenant(org.id, (tx) => tx.select().from(integrations).where(eq(integrations.kind, "zenoti")).orderBy(integrations.createdAt).limit(1));
  if (!i) throw new ZenotiCommandError(`${org.name} has no Zenoti connection yet. Connect it first: zenoti connect --tenant ${org.slug} --file <path to the key file>`);
  return i;
}

function wholeNumber(v: string | undefined, flag: string, least: number, most: number): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n < least || n > most) throw new ZenotiCommandError(`${flag} takes a whole number from ${least} to ${most}.`);
  return n;
}

/** What JENAI holds from one Zenoti connection, as counts. */
async function heldFor(tenantId: string, integrationId: string, now: Date) {
  const n = sql<number>`count(*)::int`;
  const when = (cond: SQL) => sql<number>`(count(*) filter (where ${cond}))::int`;
  return withTenant(tenantId, async (tx) => {
    const [b] = await tx.select({ all: n, coming: when(gte(clinicAppointments.startsAt, now)) }).from(clinicAppointments).where(eq(clinicAppointments.integrationId, integrationId));
    const [v] = await tx.select({ all: n, noPhone: when(isNull(visits.phoneE164)) }).from(visits).where(eq(visits.integrationId, integrationId));
    const [p] = await tx
      .select({ all: n, withPhone: when(isNotNull(externalPeople.phoneE164)), profiles: when(isNotNull(externalPeople.fetchedAt)), marketing: when(eq(externalPeople.marketingSmsConsent, true)) })
      .from(externalPeople)
      .where(eq(externalPeople.integrationId, integrationId));
    const [k] = await tx.select({ all: n, active: when(eq(packageBalances.status, "active")) }).from(packageBalances).where(eq(packageBalances.integrationId, integrationId));
    return {
      bookings: b?.all ?? 0,
      coming: b?.coming ?? 0,
      visits: v?.all ?? 0,
      noPhone: v?.noPhone ?? 0,
      people: p?.all ?? 0,
      withPhone: p?.withPhone ?? 0,
      profiles: p?.profiles ?? 0,
      marketing: p?.marketing ?? 0,
      packages: k?.all ?? 0,
      active: k?.active ?? 0,
    };
  });
}
