/**
 * Put the newest CY Police call script on the live phone agent, in place: the same
 * workflow, phone number, voice and model settings. The conversation, the rule for ending
 * the call and the call length limits change. The agent as it was is saved to a file first.
 *
 * On the police server (uses the voice engine connection saved there; nothing to type):
 *   pnpm --filter @jenai/db cy-agent --workflow 18 --slug cy-police
 *   ... --status-url http://<server>:8087/api/voice/precall   (the complaint status lookup; "off" switches it off)
 * On another computer (the voice engine API key is typed at a hidden prompt, or piped on stdin):
 *   pnpm --filter @jenai/db cy-agent --workflow 18
 * To put a saved version back:
 *   ... --restore <backup file>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { eq } from "drizzle-orm";
import { organizations, platformDb, withTenant } from "@jenai/db";
import {
  CY_CALL_SETTINGS,
  DograhClient,
  cyAgentParts,
  newStatusToken,
  publishDefinition,
  voiceClient,
  withCyConversation,
  withStatusLookup,
  type CyProgram,
} from "@jenai/engine";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  process.stdout.write("Voice engine (Dograh) API key (hidden): ");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const key = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return key.trim();
}

const workflowId = Number(arg("workflow"));
const engine = arg("engine", "https://voice.jenai.in");
const restore = arg("restore");
const slug = arg("slug");
const statusUrl = arg("status-url");
if (!Number.isInteger(workflowId) || workflowId <= 0) {
  console.error("usage: cy-agent --workflow <id> [--slug <workspace>] [--status-url <url>|off] [--restore <backup file>] [--engine https://voice.jenai.in]");
  process.exit(1);
}
if (statusUrl && !slug) throw new Error("--status-url needs --slug: the lookup's token is kept on the server that answers it.");
if (statusUrl && statusUrl !== "off" && !/^https?:\/\/\S+$/.test(statusUrl)) throw new Error("--status-url must be the full address, for example http://100.69.176.71:8087/api/voice/precall");

// The newest version of the CY Police program in this checkout.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../seed-data/programs");
const latest = readdirSync(dir)
  .filter((f) => /^police\.cy_cybercrime_complaint\.v\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/v(\d+)/)![1]) - Number(b.match(/v(\d+)/)![1]))
  .at(-1)!;
const program = JSON.parse(readFileSync(path.join(dir, latest), "utf8")) as CyProgram;
const backup = restore
  ? (JSON.parse(readFileSync(restore.replace(/^~(?=\/)/, homedir()), "utf8")) as { workflow_definition: unknown; workflow_configurations?: Record<string, unknown> | null })
  : null;

// On the police server: the connection saved for copying calls. Elsewhere: a key typed now.
let client: DograhClient;
let tenantId: string | null = null;
if (slug) {
  const [org] = await platformDb().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  if (!org) throw new Error(`No workspace "${slug}" on this server.`);
  tenantId = org.id;
  const vc = await withTenant(org.id, (tx) => voiceClient(tx, org.id));
  if (!vc) throw new Error(`The workspace "${slug}" has no voice engine connection on this server.`);
  client = vc.client;
} else {
  const apiKey = await readKey();
  if (apiKey.length < 10) throw new Error("That does not look like an API key.");
  client = new DograhClient(engine, { kind: "api_key", apiKey });
}

// Saved before anything changes, so it can always be put back.
const desktop = path.join(homedir(), "Desktop");
const name = `cy-agent-${workflowId}-before-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
const saved = JSON.stringify(await client.getWorkflow(workflowId), null, 2);
let file = path.join(existsSync(desktop) ? desktop : homedir(), name);
try {
  writeFileSync(file, saved);
} catch {
  file = path.join(tmpdir(), name);
  writeFileSync(file, saved);
}
console.log(`The agent as it is now is saved in ${file}`);

// The status lookup: a fresh token, kept by the engine as a credential and here as a hash.
let lookup: { url: string; credentialUuid: string } | null = null;
if (statusUrl && statusUrl !== "off") {
  const token = await newStatusToken(tenantId!);
  const credential = await client.saveBearerCredential("JENAI complaint status", token, "Asks the police server whether the number calling has a complaint in progress");
  lookup = { url: statusUrl, credentialUuid: credential.uuid };
}
const result = await publishDefinition(
  client,
  workflowId,
  (current) => {
    if (backup) return backup.workflow_definition as typeof current;
    const next = withStatusLookup(withCyConversation(current, cyAgentParts(program)), lookup);
    if (statusUrl !== "off") return next;
    return { ...next, nodes: next.nodes.map((n) => (n.type === "startCall" ? { ...n, data: { ...(n.data ?? {}), pre_call_fetch_mode: "disabled" } } : n)) };
  },
  (current) => (backup ? (backup.workflow_configurations ?? {}) : { ...current, ...CY_CALL_SETTINGS }),
);
if (backup) console.log(`Agent #${workflowId} (${result.name}) is back to the saved version.`);
else {
  console.log(`Agent #${workflowId} (${result.name}) now runs the CY Police call script v${program.version}.`);
  console.log(`  It ends the call itself after the WhatsApp line. Every call is cut at ${CY_CALL_SETTINGS.max_call_duration / 60} minutes; a caller silent for ${CY_CALL_SETTINGS.max_user_idle_timeout} seconds is asked once, then the call ends.`);
  console.log(lookup ? `  Complaint status lookup at the start of each call: on (${lookup.url}).` : statusUrl === "off" ? "  Complaint status lookup: off." : "  Complaint status lookup: unchanged. A caller who says they already complained hears the status.");
}
console.log(`To put the old one back: pnpm --filter @jenai/db cy-agent --workflow ${workflowId}${slug ? ` --slug ${slug}` : ""} --restore ${file}`);
process.exit(0);
