/**
 * Put the newest CY Police call script on the live phone agent, in place: the same
 * workflow, phone number, voice and model settings; only the conversation changes.
 * The agent as it was is saved to a file on the Desktop first.
 *
 *   pnpm --filter @jenai/db cy-agent --workflow 18
 *   pnpm --filter @jenai/db cy-agent --workflow 18 --restore ~/Desktop/cy-agent-18-before-<time>.json
 *
 * The voice engine API key is typed at a hidden prompt (or piped on stdin), never passed
 * as an argument.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DograhClient, cyAgentParts, publishDefinition, withCyConversation, type CyProgram } from "@jenai/engine";

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
if (!Number.isInteger(workflowId) || workflowId <= 0) {
  console.error("usage: cy-agent --workflow <id> [--restore <backup file>] [--engine https://voice.jenai.in]");
  process.exit(1);
}

// The newest version of the CY Police program in this checkout.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../seed-data/programs");
const latest = readdirSync(dir)
  .filter((f) => /^police\.cy_cybercrime_complaint\.v\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/v(\d+)/)![1]) - Number(b.match(/v(\d+)/)![1]))
  .at(-1)!;
const program = JSON.parse(readFileSync(path.join(dir, latest), "utf8")) as CyProgram;
const backup = restore ? (JSON.parse(readFileSync(restore.replace(/^~(?=\/)/, homedir()), "utf8")) as { workflow_definition: unknown }) : null;

const apiKey = await readKey();
if (apiKey.length < 10) throw new Error("That does not look like an API key.");
const client = new DograhClient(engine, { kind: "api_key", apiKey });

// Saved before anything changes, so it can always be put back.
const file = path.join(homedir(), "Desktop", `cy-agent-${workflowId}-before-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(await client.getWorkflow(workflowId), null, 2));
console.log(`The agent as it is now is saved in ${file}`);
const result = await publishDefinition(client, workflowId, (current) =>
  backup ? (backup.workflow_definition as typeof current) : withCyConversation(current, cyAgentParts(program)),
);
console.log(backup ? `Agent #${workflowId} (${result.name}) is back to the saved version.` : `Agent #${workflowId} (${result.name}) now runs the CY Police call script v${program.version}.`);
console.log(`To put the old one back: pnpm --filter @jenai/db cy-agent --workflow ${workflowId} --restore ${file}`);
process.exit(0);
