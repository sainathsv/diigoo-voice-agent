"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { recordSecurityEvent } from "@/lib/security-events";
import { requireUser, requestMeta } from "../session";

const back = (msg: { ok?: string; error?: string }): never => {
  redirect(`/account/security?${new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Done" })}#sessions`);
};

/** Signs out one of your other devices. Sessions are looked up by id; tokens never reach the page. */
export async function signOutDevice(fd: FormData) {
  const u = await requireUser();
  const id = String(fd.get("sessionId") ?? "");
  const h = await headers();
  const mine = await auth.api.listSessions({ headers: h });
  const target = mine.find((s) => s.id === id);
  if (!target) back({ error: "That device is already signed out." });
  await auth.api.revokeSession({ headers: h, body: { token: target!.token } });
  await recordSecurityEvent("session_revoked", { userId: u.id, email: u.email, detail: { scope: "one", sessionId: id }, ...(await requestMeta()) });
  back({ ok: "Signed out of that device." });
}

export async function signOutEverywhereElse() {
  const u = await requireUser();
  const h = await headers();
  const before = (await auth.api.listSessions({ headers: h })).length;
  await auth.api.revokeOtherSessions({ headers: h });
  await recordSecurityEvent("session_revoked", { userId: u.id, email: u.email, detail: { scope: "others", count: Math.max(0, before - 1) }, ...(await requestMeta()) });
  back({ ok: before > 1 ? `Signed out of ${before - 1} other device${before - 1 === 1 ? "" : "s"}.` : "No other devices were signed in." });
}
