/**
 * Attack harness: talks to the running app over HTTP exactly like a browser or
 * an attacker would. No shortcuts through application code.
 */
import "@jenai/db/env";
import { randomInt } from "node:crypto";

export const BASE = process.env.ATTACK_BASE ?? "http://localhost:3100";
const PASSWORD = process.env.SEED_PASSWORD ?? "";

const ip = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;

export interface Session {
  cookie: string;
  email: string;
}

function cookiesFrom(res: Response): string {
  const all = res.headers.getSetCookie?.() ?? [];
  return all.map((c) => c.split(";")[0]).join("; ");
}

/** Sign in through the real endpoint. Each login uses its own client IP so the IP limiter does not throttle the suite. */
export async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "x-jenai-client-ip": ip() },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status}`);
  return { cookie: cookiesFrom(res), email };
}

export async function get(path: string, s?: Session, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { ...(s ? { Cookie: s.cookie } : {}), ...headers }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), headers: res.headers, text: await res.text() };
}

/** Every server-action id on a page, in document order, with the field names of its form. */
export function actionForms(html: string): Array<{ id: string; fields: string[] }> {
  const out: Array<{ id: string; fields: string[] }> = [];
  const re = /<form\b[^>]*>([\s\S]*?)<\/form>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const inner = m[1]!;
    const id = inner.match(/name="(\$ACTION_ID_[0-9a-f]+)"/)?.[1];
    if (!id) continue;
    const fields = [...inner.matchAll(/name="([^"$][^"]*)"/g)].map((x) => x[1]!);
    out.push({ id, fields });
  }
  return out;
}

/** Find the server action whose form carries all of these field names. */
export function findAction(html: string, mustHave: string[]): string {
  const f = actionForms(html).find((x) => mustHave.every((n) => x.fields.includes(n)));
  if (!f) throw new Error(`No form with fields ${mustHave.join(", ")}`);
  return f.id;
}

/** Submit a server action the way a no-JavaScript browser form does. */
export async function postAction(path: string, actionId: string, fields: Record<string, string>, s?: Session, headers: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set(actionId, "");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    body: fd,
    redirect: "manual",
    headers: { Origin: BASE, ...(s ? { Cookie: s.cookie } : {}), ...headers },
  });
  return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
}

export async function appUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}
