/**
 * Upload a client's visit list from the command line: the services people
 * actually took, as a CSV exported from their front desk or billing software.
 *
 *   pnpm --filter @jenai/db visits import --tenant zennara --file ~/Downloads/services-sep.csv
 *
 * Does what the upload in the workspace does: stores the visits and a contact
 * for every number, then plans everyone's calls again. Nothing is dialled.
 * Prints counts, and each refused row by its number with the reason. Never a
 * name, number or service: the file is health data, and terminals are logged.
 */
import "./env";
import { readFile, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { VISIT_IMPORT_MAX_BYTES, VisitImportError, decodeVisitFile, importVisits } from "@jenai/engine";
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
  for (const j of ["visit_feedback", "result_check", "next_session", "maintenance"] as const) {
    const n = r.plan.byJourney[j];
    if (n) console.log(`    ${j.padEnd(16)} ${Object.entries(n).map(([k, c]) => `${c} ${k.replace("_", " ")}`).join(", ")}`);
  }
  console.log("  Nothing was dialled. This is the plan only.\n");
}

if (process.argv[2] !== "import") {
  console.log("usage: visits import --tenant <address> --file <path to the CSV>");
  process.exit(1);
}
try {
  await importFile();
} catch (e) {
  // A file that cannot be read says why in plain words; anything else is a fault worth its stack.
  if (!(e instanceof VisitImportError)) throw e;
  console.error(`\n  Not imported: ${e.message}\n`);
  process.exit(1);
}
process.exit(0);
