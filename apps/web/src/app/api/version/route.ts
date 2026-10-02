import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Which build this server runs: the git commit (with "-dirty" when it carried
 * uncommitted changes) and when it was deployed. Written by the deploy scripts,
 * so two servers can be compared at a glance.
 */
export function GET() {
  let version = "unknown";
  try {
    version = readFileSync(/*turbopackIgnore: true*/ process.env.JENAI_VERSION_FILE ?? "/opt/jenai/app/VERSION", "utf8").trim().slice(0, 120);
  } catch {
    // Not deployed by a script (local development).
  }
  return NextResponse.json({ version }, { headers: { "Cache-Control": "no-store" } });
}
