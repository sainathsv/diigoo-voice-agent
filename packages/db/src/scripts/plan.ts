/**
 * Look at a client's call plan, or change one of its settings.
 *
 *   pnpm --filter @jenai/db plan show --tenant zennara
 *   pnpm --filter @jenai/db plan set --tenant zennara --key centres --value '["Main Branch"]'
 *   pnpm --filter @jenai/db plan set --tenant zennara --key freshDays --value null
 *   pnpm --filter @jenai/db plan on --tenant zennara
 *   pnpm --filter @jenai/db plan off --tenant zennara
 *
 * show prints where the plan is read from (each CRM and front desk
 * connection, such as Zenoti, with when it was last read and is next read),
 * the counts per journey and verdict, the settings the client changed, and
 * the next 20 calls JENAI would make, with the number masked; a call already
 * due says "now (due since ...)" inside calling hours, and the next calling
 * hours outside them, as the workspace's call plan page does. set stores one
 * setting (null puts back the default) and plans everyone's calls again. on
 * switches the plan on, so the worker reads the client's CRM and front desk
 * system on a timer; off stops that. Never prints a name, a full number or a
 * reason: a reason can name a treatment or a doctor, and terminals are
 * logged. Nothing is dialled.
 */
import "./env";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { PlanSettingError, PlanSwitchError, SETTABLE_PLAN_KEYS, errorText, planReadKinds, planSummary, setPlanEnabled, setPlanSetting, type ReplanResult } from "@jenai/engine";
import { callPlanSettings, integrations, organizations, platformDb, withTenant } from "../index";
import { callTime, planTable, when } from "./plan-text";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
/** Calls listed by show. */
const UPCOMING = 20;

async function client() {
  const slug = arg("tenant");
  if (!slug) throw new Error("need --tenant <address>");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org || org.kind !== "client") throw new Error(`No client with the address "${slug}".`);
  return org;
}

async function show() {
  const org = await client();
  const s = await planSummary(org.id, { upcoming: UPCOMING });
  const [own] = await withTenant(org.id, (tx) => tx.select({ settings: callPlanSettings.settings, enabled: callPlanSettings.enabled }).from(callPlanSettings));
  console.log(`\n${org.name}: call plan${s.computedAt ? `, worked out ${when(s.computedAt, org.timezone)}` : ""}`);
  console.log(
    own?.enabled
      ? "  switched on: their CRM and front desk system are read on a timer (when the worker reads at all)"
      : "  switched off: their CRM and front desk system are not read on a timer (plan on --tenant ... to start)",
  );
  await sources(org.id, org.timezone);
  if (!s.rows) console.log("\n  No plan yet. It is worked out after a CRM read (zoho pull), a Zenoti read (zenoti sync), a visit list upload (visits import) or a settings change.");
  else {
    console.log("");
    for (const line of planTable(s.byVerdict, s.byJourney)) console.log(`  ${line}`);
  }

  const changed = Object.entries(own?.settings ?? {});
  console.log(changed.length ? "\n  settings changed from the defaults" : "\n  settings   all at their defaults");
  for (const [k, v] of changed) console.log(`    ${k.padEnd(24)} ${JSON.stringify(v)}`);

  if (s.next.length) {
    const now = new Date();
    console.log(`\n  next ${s.next.length} calls (times in ${org.timezone})`);
    const times = s.next.map((c) => callTime(c, now, org.timezone, s.callingWindow));
    const width = Math.max(24, ...times.map((t) => t.length));
    s.next.forEach((c, n) => console.log(`    ${times[n]!.padEnd(width)} ${c.verdict.padEnd(10)} ${c.journey.padEnd(22)} ${c.phone.padEnd(18)} ${c.origin}`));
  }
  console.log("\n  Nothing is dialled from the plan. It is a preview.\n");
}

/** The connections the plan is read from, each with its state and when it was last and is next read. Plain words only. */
async function sources(tenantId: string, timeZone: string) {
  const kinds = planReadKinds();
  const conns = await withTenant(tenantId, (tx) =>
    tx
      .select({
        name: integrations.name,
        kind: integrations.kind,
        status: integrations.status,
        lastPullAt: integrations.lastPullAt,
        nextPullAt: integrations.nextPullAt,
        lastPullError: integrations.lastPullError,
      })
      .from(integrations)
      .where(inArray(sql<string>`${integrations.kind}::text`, kinds))
      .orderBy(asc(integrations.createdAt)),
  );
  if (!conns.length) {
    console.log("  read from  no CRM or front desk system connected");
    return;
  }
  console.log("  read from");
  for (const c of conns) {
    const read = c.lastPullAt ? `last read ${when(c.lastPullAt, timeZone)}` : "not read yet";
    const next = c.nextPullAt ? `, next ${when(c.nextPullAt, timeZone)}` : "";
    console.log(`    ${KIND_NAMES[c.kind] ?? c.kind}: ${c.name}, ${c.status}, ${read}${next}`);
    // A problem is said in plain words, naming modules, days or centres: never a person.
    if (c.lastPullError) console.log(`      last read had a problem: ${c.lastPullError.slice(0, 200)}`);
  }
}

const KIND_NAMES: Record<string, string> = { zoho_crm: "Zoho CRM", zenoti: "Zenoti" };

/** The plan's counts, and what waits for a phone number or was agreed at the front desk. */
function printPlan(plan: ReplanResult) {
  for (const line of planTable(plan.byVerdict, plan.byJourney)) console.log(`  ${line}`);
  if (plan.waitingForPhone) console.log(`  ${plan.waitingForPhone} ${plan.waitingForPhone === 1 ? "visit" : "visits"} from a connected system waiting for a phone number, not planned yet`);
  if (plan.marketingConsent)
    console.log(`  ${plan.marketingConsent} ${plan.marketingConsent === 1 ? "person has" : "people have"} agreed to marketing SMS in their front desk system (a count only: no call is planned on it)`);
}

async function set() {
  const org = await client();
  const key = arg("key");
  const raw = arg("value");
  if (!key || !raw) throw new PlanSettingError(`need --key <setting> --value <JSON>. The settings are: ${SETTABLE_PLAN_KEYS.join(", ")}.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PlanSettingError(`--value must be JSON, such as 30, '["Main Branch"]' or null to put back the default.`);
  }
  const r = await setPlanSetting(org.id, key, value, { via: "system" });
  console.log(`\n${org.name}: ${key} ${value === null ? "put back to its default" : `set to ${JSON.stringify(value)}`}`);
  console.log(`\n  call plan  ${r.plan.people} people, ${r.plan.rows} rows (${r.plan.removed} no longer apply)`);
  printPlan(r.plan);
  console.log("  Nothing was dialled. This is the plan only.\n");
}

async function onOff(on: boolean) {
  const org = await client();
  const r = await setPlanEnabled(org.id, on, { via: "system" });
  console.log(
    `\n${org.name}: call plan switched ${on ? "on. The worker reads their CRM and front desk system on a timer from now on (with JENAI_PULL=true)" : "off. Their CRM and front desk system are not read on a timer any more"}.`,
  );
  if (r.plan) printPlan(r.plan);
  console.log("  Nothing was dialled. This is the plan only.\n");
}

const command = process.argv[2];
try {
  if (command === "show") await show();
  else if (command === "set") await set();
  else if (command === "on" || command === "off") await onOff(command === "on");
  else {
    console.log("usage: plan show --tenant <address>\n       plan set --tenant <address> --key <setting> --value <JSON, or null for the default>\n       plan on|off --tenant <address>");
    process.exit(1);
  }
} catch (e) {
  // A change the plan cannot take says why in plain words. Anything else is
  // shown without its detail: a failed query's message carries the rows it
  // was writing, names and numbers included, and terminals are logged.
  console.error(`\n  Not changed: ${e instanceof PlanSettingError || e instanceof PlanSwitchError ? e.message : errorText(e)}\n`);
  process.exit(1);
}
process.exit(0);
