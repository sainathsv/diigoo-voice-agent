import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Scripts run from packages/db; the .env lives at the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../../.env"), quiet: true });

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}
