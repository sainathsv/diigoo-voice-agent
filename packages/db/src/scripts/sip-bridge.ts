/**
 * Connects the voice engine to the police server's Asterisk, the bridge to the department's SIP
 * server, with the voice engine connection saved on this server. Run by sip-bridge-setup.sh:
 *
 *   <ari password on stdin> | pnpm --filter @jenai/db sip-bridge --slug cy-police --workflow 18 \
 *     --ari http://100.69.176.71:8088 --extension 1930
 *
 * The password is read from stdin, never an argument. Prints, one per line:
 *   stasis=<the Stasis application the dialplan hands calls to>
 *   media=<the WebSocket address Asterisk streams each call's audio to>
 */
import { eq } from "drizzle-orm";
import { organizations, platformDb, withTenant } from "@jenai/db";
import { ariMediaUri, connectSipBridge, voiceClient } from "@jenai/engine";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : "";
};
const [slug, workflowId, ari, extension] = [arg("slug"), Number(arg("workflow")), arg("ari"), arg("extension") || "1930"];
if (!slug || !Number.isInteger(workflowId) || workflowId <= 0 || !/^https?:\/\/[^\s/]+$/.test(ari) || !/^[0-9A-Za-z]+$/.test(extension)) {
  console.error("usage: <password> | sip-bridge --slug <workspace> --workflow <id> --ari http://<host>:8088 [--extension 1930]");
  process.exit(1);
}
let password = "";
for await (const chunk of process.stdin) password += chunk;
password = password.trim();
if (password.length < 16) throw new Error("The ARI password on stdin is missing or too short.");

const [org] = await platformDb().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
if (!org) throw new Error(`No workspace "${slug}" on this server.`);
const vc = await withTenant(org.id, (tx) => voiceClient(tx, org.id));
if (!vc) throw new Error(`The workspace "${slug}" has no voice engine connection on this server.`);
const r = await connectSipBridge(vc.client, { ariEndpoint: ari, ariUser: "jenai", ariPassword: password, wsClientName: "dograh", extension, workflowId });
console.log(`stasis=${r.stasisApp}`);
console.log(`media=${ariMediaUri(vc.conn.baseUrl)}`);
process.exit(0);
