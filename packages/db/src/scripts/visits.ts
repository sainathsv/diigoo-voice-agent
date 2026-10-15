/**
 * Upload a client's visit list from the command line: the services people
 * actually took, as a CSV exported from their front desk or billing software.
 *
 *   pnpm --filter @jenai/db visits import --tenant zennara --file ~/Downloads/services-sep.csv
 *   pnpm --filter @jenai/db visits remove --tenant zennara --batch <upload id from the audit log>
 *   ERASE_PHONE=+919876543210 pnpm --filter @jenai/db visits erase --tenant zennara
 *
 * Does what the upload in the workspace does: stores the visits and a contact
 * for every number, then plans everyone's calls again. Nothing is dialled.
 * Prints counts, and each refused row by its number with the reason. Never a
 * name, number or service: the file is health data, and terminals are logged.
 *
 * remove takes out the visits one upload added or last changed. erase takes
 * one person's number out of the plan's copies (visits, CRM records read,
 * front desk bookings, packages and guests read, planned calls), for someone
 * who asked the clinic to erase their data; the
 * number comes from the environment, so it stays out of shell history.
 */
import "./env";
import { readFile, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { VISIT_IMPORT_MAX_BYTES, VisitImportError, VisitRemovalError, decodeVisitFile, eraseNumber, errorText, importVisits, removeVisitUpload } from "@jenai/engine";
import { organizations, platformDb } from "../index";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
/** Refused rows printed; the rest are counted. */
const SHOW = 200;

async function importFile() {
  const slug = arg("tenant");
  const file = arg("file");
  if (!slug || !file) throw new Error("need --tenant <address> --file <path to the CSV>");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org || org.kind !== "client") throw new Error(`No client with the address "${slug}".`);
  if ((await stat(file)).size > VISIT_IMPORT_MAX_BYTES) throw new Error("The file is larger than 5 MB. Split it into smaller files by date.");

  console.log(`\n${org.name}: importing the visit list`);
  const r = await importVisits(org.id, decodeVisitFile(await readFile(file)), { source: "upload", uploadedBy: null });

  const cols = Object.entries(r.columns).map(([field, name]) => `${field} from "${name}"`);
  console.log(`  columns    ${cols.join(", ")}`);
  console.log(`  rows       ${r.rows}`);
  console.log(`  added      ${r.added}`);
  console.log(`  updated    ${r.updated}`);
  console.log(`  unchanged  ${r.unchanged}`);
  if (r.repeated) console.log(`  repeated   ${r.repeated} (the same person, service and day again in this file: kept once)`);
  console.log(`  refused    ${r.rejected.length}`);
  for (const x of r.rejected.slice(0, SHOW)) console.log(`    row ${x.row}: ${x.reason}`);
  if (r.rejected.length > SHOW) console.log(`    and ${r.rejected.length - SHOW} more`);

  const v = r.plan.byVerdict;
  console.log(`\n  call plan  ${r.plan.people} people: ${v.call_now} to call now, ${v.scheduled} scheduled, ${v.waiting} waiting for another call, ${v.kept_out} kept out`);
  const w = r.plan.waitingForPhone;
  if (w) console.log(`    ${w} ${w === 1 ? "visit" : "visits"} from a connected system waiting for a phone number, not planned yet`);
  const m = r.plan.marketingConsent;
  if (m) console.log(`    ${m} ${m === 1 ? "person has" : "people have"} agreed to marketing SMS in their front desk system (a count only: no call is planned on it)`);
  for (const j of ["visit_feedback", "course_checkin", "result_check", "maintenance"] as const) {
    const n = r.plan.byJourney[j];
    if (n) console.log(`    ${j.padEnd(16)} ${Object.entries(n).map(([k, c]) => `${c} ${k.replace("_", " ")}`).join(", ")}`);
  }
  console.log("  Nothing was dialled. This is the plan only.\n");
}

async function client() {
  const slug = arg("tenant");
  if (!slug) throw new Error("need --tenant <address>");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org || org.kind !== "client") throw new Error(`No client with the address "${slug}".`);
  return org;
}

async function remove() {
  const org = await client();
  const r = await removeVisitUpload(org.id, arg("batch"), { removedBy: null });
  const kept = r.kept ? `; ${r.kept} also read from a connected system ${r.kept === 1 ? "stays" : "stay"}` : "";
  console.log(`\n${org.name}: ${r.removed} ${r.removed === 1 ? "visit" : "visits"} taken out${kept}, and the plan worked out again (${r.plan.rows} rows).\n`);
}

async function erase() {
  const org = await client();
  const phone = process.env.ERASE_PHONE ?? "";
  if (!phone) throw new VisitRemovalError("Put the number in ERASE_PHONE, not on the command line.");
  const r = await eraseNumber(org.id, phone, { removedBy: null });
  console.log(`\n${org.name}: erased the number ending ${phone.trim().slice(-4)}: ${r.visits} visits, ${r.records} CRM records, ${r.frontDesk} front desk records, ${r.planned} planned calls.`);
  console.log("  Delete them in the clinic's CRM and front desk system too, or the next read brings them back.\n");
}

const command = process.argv[2];
const run = { import: importFile, remove, erase }[command as "import" | "remove" | "erase"];
if (!run) {
  console.log("usage: visits import --tenant <address> --file <path to the CSV>\n       visits remove --tenant <address> --batch <upload id>\n       ERASE_PHONE=<number> visits erase --tenant <address>");
  process.exit(1);
}
try {
  await run();
} catch (e) {
  // A file that cannot be read says why in plain words. Anything else is shown
  // without its detail: a failed query's message carries every row it was
  // writing (names, numbers, services), and terminals are logged.
  console.error(`\n  Not done: ${e instanceof VisitImportError || e instanceof VisitRemovalError ? e.message : errorText(e)}\n`);
  process.exit(1);
}
process.exit(0);
