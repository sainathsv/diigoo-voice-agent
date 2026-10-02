/**
 * Connect a client workspace to the voice engine from the command line, the
 * same three steps as the console's Voice engine card: save the connection
 * (read-only), import one live agent unchanged, pull its calls.
 *
 *   pnpm --filter @jenai/db voice --slug cy-police --inbound 18 --name "CY Police Cyber Complaint" --domain "cyber crime"
 *
 * The API key is typed at a hidden prompt (or piped on stdin), never passed as
 * an argument, so it stays out of shell history and process listings.
 */
import { eq, or } from "drizzle-orm";
import { createInterface } from "node:readline";
import "./env";
import { analyzeCalls, extractorFromEnv, importAgent, markConnection, saveVoiceConnection, syncTenantCalls, voiceClient } from "@jenai/engine";
import { agents, audit, calls, organizations, platformDb, withTenant } from "../index";

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
  process.stdout.write("Voice engine API key (hidden): ");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const key = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return key.trim();
}

const slug = arg("slug");
// --sync-only: pull calls with the saved connection (no key, no import).
// --refetch: also re-read every call still missing its transcript (or kept recording), however old.
const syncOnly = process.argv.includes("--sync-only");
const refetch = process.argv.includes("--refetch");
// --reanalyze: read every call again with the analyser (e.g. after the complaint questions change).
const reanalyze = process.argv.includes("--reanalyze");
const inbound = Number(arg("inbound")) || null;
const outbound = Number(arg("outbound")) || null;
const name = arg("name");
const domain = arg("domain", "business");
const baseUrl = arg("engine", "https://voice.jenai.in");
if (!slug || (!syncOnly && (!name || (!inbound && !outbound)))) {
  console.error('usage: voice --slug <workspace> --inbound <workflow id> [--outbound <id>] --name "<agent name>" [--domain "<domain>"]');
  console.error("       voice --slug <workspace> --sync-only [--refetch]");
  process.exit(1);
}

const [org] = await platformDb().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
if (!org) throw new Error(`No workspace with slug ${slug}.`);
const tenantId = org.id;

async function pull() {
  // --refetch re-reads every answered call still missing its transcript (or, with
  // JENAI_STORE_RECORDINGS=true, its recording), however old, without changing any call's
  // status (a call is never left looking unfinished).
  const s = await syncTenantCalls(tenantId, { maxPerWorkflow: 500, fetchTranscripts: true, full: refetch });
  const notes = [
    s.recordingsStored && `${s.recordingsStored} recording(s) copied to this server`,
    s.transcriptMisses && `${s.transcriptMisses} transcript(s) could not be downloaded`,
    s.recordingMisses && `${s.recordingMisses} recording(s) could not be copied`,
    s.errors.length && `errors: ${s.errors.join("; ")}`,
  ].filter(Boolean);
  console.log(`calls: ${s.inserted} new, ${s.updated} updated, ${s.runsSeen} seen${notes.map((n) => `; ${n}`).join("")}`);
  if (reanalyze) {
    await withTenant(tenantId, (tx) => tx.update(calls).set({ analyzedAt: null }).where(eq(calls.provider, "dograh")));
    const a = await analyzeCalls(tenantId, extractorFromEnv(), { limit: 200 });
    console.log(`analysed ${a.analyzed} call(s), ${a.failed} failed`);
  }
}

if (syncOnly) {
  await pull();
  process.exit(0);
}

const apiKey = await readKey();
if (apiKey.length < 10) throw new Error("That does not look like an API key.");

await withTenant(tenantId, async (tx) => {
  await saveVoiceConnection(tx, tenantId, { baseUrl, externalOrgId: null, auth: { kind: "api_key", apiKey }, mode: "read_only" }, null);
  await audit(tx, { tenantId, actorUserId: null, via: "system", action: "voice.connection_saved", summary: "Voice engine connection saved from the command line (API key, read-only)" });
});
const v = await withTenant(tenantId, (tx) => voiceClient(tx, tenantId));
try {
  await v!.client.listWorkflows();
  await withTenant(tenantId, (tx) => markConnection(tx, tenantId, { status: "ok", lastError: null, lastVerifiedAt: new Date() }));
  console.log("connected (read-only)");
} catch (e) {
  await withTenant(tenantId, (tx) => markConnection(tx, tenantId, { status: "error", lastError: (e as Error).message.slice(0, 300) }));
  throw new Error(`Saved, but the engine refused the connection: ${(e as Error).message}`);
}

// An agent already linked to either workflow is not imported twice.
const have = await withTenant(tenantId, (tx) =>
  tx.select().from(agents).where(or(eq(agents.inboundWorkflowId, inbound ?? -1), eq(agents.outboundWorkflowId, outbound ?? -1))),
);
if (have.length) {
  console.log(`agent for workflow ${inbound ?? outbound} already imported`);
} else {
  const r = await importAgent(tenantId, { name, branchId: null, purpose: "receptionist", domain, inboundWorkflowId: inbound, outboundWorkflowId: outbound }, null);
  await withTenant(tenantId, (tx) =>
    audit(tx, { tenantId, actorUserId: null, via: "system", action: "agent.imported", targetType: "agent", targetId: r.agent.id, summary: `Imported live agent "${name}" from the command line, unchanged` }),
  );
  console.log(`imported "${name}" (workflow ${inbound ?? outbound})`);
}

await pull();
process.exit(0);
