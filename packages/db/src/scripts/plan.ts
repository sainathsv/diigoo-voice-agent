/**
 * Look at a client's call plan, or change one of its settings.
 *
 *   pnpm --filter @jenai/db plan show --tenant zennara
 *   pnpm --filter @jenai/db plan set --tenant zennara --key centres --value '["Main Branch"]'
 *   pnpm --filter @jenai/db plan set --tenant zennara --key freshDays --value null
 *
 * show prints the counts per journey and verdict, the settings the client
 * changed, and the next 20 calls JENAI would make, with the number masked.
 * set stores one setting (null puts back the default) and plans everyone's
 * calls again. Never prints a name, a full number or a reason: a reason can
 * name a treatment or a doctor, and terminals are logged. Nothing is dialled.
 */
import "./env";
import { eq } from "drizzle-orm";
import { PlanSettingError, SETTABLE_PLAN_KEYS, planSummary, setPlanSetting } from "@jenai/engine";
import { callPlanSettings, organizations, platformDb, withTenant } from "../index";
import { planTable, when } from "./plan-text";

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
  const [own] = await withTenant(org.id, (tx) => tx.select({ settings: callPlanSettings.settings }).from(callPlanSettings));
  console.log(`\n${org.name}: call plan${s.computedAt ? `, worked out ${when(s.computedAt, org.timezone)}` : ""}`);
  if (!s.rows) console.log("  No plan yet. It is worked out after a CRM read (zoho pull), a visit list upload (visits import) or a settings change.");
  else for (const line of planTable(s.byVerdict, s.byJourney)) console.log(`  ${line}`);

  const changed = Object.entries(own?.settings ?? {});
  console.log(changed.length ? "\n  settings changed from the defaults" : "\n  settings   all at their defaults");
  for (const [k, v] of changed) console.log(`    ${k.padEnd(24)} ${JSON.stringify(v)}`);

  if (s.next.length) {
    console.log(`\n  next ${s.next.length} calls (times in ${org.timezone})`);
    for (const c of s.next) {
      console.log(`    ${when(c.callAt, org.timezone).padEnd(24)} ${c.verdict.padEnd(10)} ${c.journey.padEnd(22)} ${c.phone.padEnd(18)} ${c.origin}`);
    }
  }
  console.log("\n  Nothing is dialled from the plan. It is a preview.\n");
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
  for (const line of planTable(r.plan.byVerdict, r.plan.byJourney)) console.log(`  ${line}`);
  console.log("  Nothing was dialled. This is the plan only.\n");
}

const command = process.argv[2];
try {
  if (command === "show") await show();
  else if (command === "set") await set();
  else {
    console.log("usage: plan show --tenant <address>\n       plan set --tenant <address> --key <setting> --value <JSON, or null for the default>");
    process.exit(1);
  }
} catch (e) {
  // A setting the plan cannot use says why in plain words; anything else is a fault worth its stack.
  if (!(e instanceof PlanSettingError)) throw e;
  console.error(`\n  Not changed: ${e.message}\n`);
  process.exit(1);
}
process.exit(0);
