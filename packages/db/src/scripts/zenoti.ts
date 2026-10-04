/**
 * Connect a client's Zenoti, test what its key may read, and read it once.
 *
 *   pnpm --filter @jenai/db zenoti connect --tenant zennara --file ~/zenoti-key.json
 *   pnpm --filter @jenai/db zenoti test --tenant zennara
 *   pnpm --filter @jenai/db zenoti sync --tenant zennara [--days 180] [--budget 30]
 *
 * The key file is JSON: {"api_key": "...", "app_id": "...", "app_secret": "..."},
 * as Zenoti showed them when the clinic's admin made a backend app for JENAI
 * (only api_key is needed). The key is read from that file only, never from
 * an argument or the environment, so it stays out of shell history and the
 * process list; delete the file once connected, because the key is sealed.
 *
 * connect stores the key on the client's one Zenoti connection (connecting
 * again replaces the key and keeps the settings), tests it, and prints the
 * centres, what the key may read, and what to ask their Zenoti admin for.
 * test does the test again. sync reads Zenoti once, at most --budget calls
 * (30 unless said), after widening how many days back it reads to --days,
 * and prints counts per table and the call plan per journey and verdict.
 *
 * JENAI only reads Zenoti. Nothing here writes to it, dials anyone or makes
 * campaign targets, and nothing printed is a key, a guest's name or a number.
 */
import "./env";
import { ZenotiCommandError, connectCommand, syncCommand, testCommand } from "./zenoti-commands";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const USAGE = [
  "usage: zenoti connect --tenant <address> --file <path to the key file>",
  "       zenoti test    --tenant <address>",
  "       zenoti sync    --tenant <address> [--days N] [--budget N]",
  '  the key file holds {"api_key": "...", "app_id": "...", "app_secret": "..."}; only api_key is needed',
].join("\n");

const command = process.argv[2];
const tenant = arg("tenant") ?? "";
try {
  if (command === "connect") await connectCommand({ tenant, file: arg("file") ?? "" });
  else if (command === "test") await testCommand({ tenant });
  else if (command === "sync") await syncCommand({ tenant, days: arg("days"), budget: arg("budget") });
  else {
    console.log(USAGE);
    process.exit(1);
  }
} catch (e) {
  // A mistake in what was asked says why in plain words; anything else is a fault worth its stack.
  if (!(e instanceof ZenotiCommandError)) throw e;
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
process.exit(0);
