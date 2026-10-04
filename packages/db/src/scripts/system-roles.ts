import { eq } from "drizzle-orm";
import { CLIENT_ROLE_TEMPLATES, PLATFORM_ROLE_TEMPLATES } from "@jenai/authz";
import type { Db } from "../client";
import { roles } from "../schema";

/**
 * Built-in roles follow the code. Permissions are read from these rows, not
 * from the templates, so a permission added in code reaches existing
 * databases only through here (run by the seed and by the catalog step of
 * every deploy) or a migration. Returns the roles it changed, as side:key.
 */
export async function syncSystemRoles(db: Db): Promise<string[]> {
  const rows = await db.select().from(roles).where(eq(roles.isSystem, true));
  const changed: string[] = [];
  for (const [side, list] of [["client", CLIENT_ROLE_TEMPLATES], ["platform", PLATFORM_ROLE_TEMPLATES]] as const) {
    for (const t of list) {
      const r = rows.find((x) => x.side === side && x.key === t.key && x.tenantId === null);
      const want = [...t.permissions].sort();
      if (r && JSON.stringify([...r.permissions].sort()) !== JSON.stringify(want)) {
        await db.update(roles).set({ permissions: want, description: t.description, updatedAt: new Date() }).where(eq(roles.id, r.id));
        changed.push(`${side}:${t.key}`);
      }
    }
  }
  return changed;
}
