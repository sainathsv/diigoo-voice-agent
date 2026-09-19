import "server-only";
import { notFound } from "next/navigation";
import { recordSecurityEvent } from "@/lib/security-events";
import { requestMeta } from "./session";

interface Who {
  user: { userId: string };
  org?: { id: string };
}

/**
 * Refuse and record. Renders the same 404 as a page that does not exist (so
 * nothing is revealed), and logs an access_denied event so repeated probing
 * shows up on the Security page.
 */
export async function deny(who: Who, detail: Record<string, unknown>): Promise<never> {
  await recordSecurityEvent("access_denied", { userId: who.user.userId, tenantId: who.org?.id ?? null, detail, ...(await requestMeta()) });
  notFound();
}

export async function logDenied(who: Who, detail: Record<string, unknown>): Promise<void> {
  await recordSecurityEvent("access_denied", { userId: who.user.userId, tenantId: who.org?.id ?? null, detail, ...(await requestMeta()) });
}
