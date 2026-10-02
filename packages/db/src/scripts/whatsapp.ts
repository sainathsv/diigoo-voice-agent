/**
 * Connect a workspace to the OpenWA WhatsApp gateway on this server. The police
 * number is then linked from the portal's WhatsApp page by scanning a QR code.
 *
 *   pnpm --filter @jenai/db whatsapp --slug cy-police --openwa http://127.0.0.1:2785
 *
 * The gateway's API key is read at a hidden prompt (or piped on stdin), never passed as
 * an argument, so it stays out of shell history and process listings.
 */
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import "./env";
import { channelCredentials } from "@jenai/engine";
import { audit, organizations, platformDb, sealSecret, whatsappChannels, withTenant } from "../index";

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
  process.stdout.write("OpenWA API key (hidden): ");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const key = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return key.trim();
}

const slug = arg("slug");
const base = arg("openwa", "http://127.0.0.1:2785").replace(/\/+$/, "");
if (!slug || !/^https?:\/\/[^/]+$/.test(base)) {
  console.error("usage: whatsapp --slug <workspace> [--openwa http://127.0.0.1:2785]   (API key at the prompt or on stdin)");
  process.exit(1);
}
const [org] = await platformDb().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
if (!org) throw new Error(`No workspace with slug ${slug}.`);
const tenantId = org.id;

const apiKey = await readKey();
if (apiKey.length < 32) throw new Error("That does not look like the OpenWA API key (it is at least 32 characters).");
// Nothing is saved until the gateway answers and accepts the key.
const r = await fetch(`${base}/api/sessions`, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => {
  throw new Error(`The gateway at ${base} did not answer: ${e.message}`);
});
if (!r.ok) throw new Error(`The gateway at ${base} refused the key (${r.status}).`);

await withTenant(tenantId, async (tx) => {
  const [ch] = await tx.select().from(whatsappChannels).where(eq(whatsappChannels.tenantId, tenantId)).limit(1);
  // A number already linked keeps its webhook secret, so events keep arriving.
  const prior = ch ? channelCredentials(ch) : null;
  const credentials = sealSecret(tenantId, "whatsapp", JSON.stringify({ apiKey, webhookSecret: prior?.apiKey === apiKey ? prior.webhookSecret : null }));
  if (ch) await tx.update(whatsappChannels).set({ mode: "openwa", openwaUrl: base, credentials, status: "active", updatedAt: new Date() }).where(eq(whatsappChannels.id, ch.id));
  else await tx.insert(whatsappChannels).values({ tenantId, mode: "openwa", openwaUrl: base, credentials, status: "active" });
  await audit(tx, { tenantId, actorUserId: null, via: "system", action: "whatsapp.gateway_connected", targetType: "whatsapp_channel", summary: `WhatsApp gateway (OpenWA) connected from the command line at ${base}` });
});
console.log("OpenWA connected. Open the portal's WhatsApp page and click 'Link the WhatsApp number'.");
process.exit(0);
