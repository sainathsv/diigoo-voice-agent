/**
 * Two-step sign-in, end to end over HTTP, with a throwaway account. Codes are
 * computed exactly as an authenticator app does (RFC 6238, SHA-1, 30 s, 6 digits).
 * Needs the app running (pnpm dev).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { account, platformDb, securityEvents, user } from "@jenai/db";
import { BASE, appUp, get } from "./harness";

const db = platformDb();
const run = randomUUID().slice(0, 8);
const email = `mfa-${run}@twostep.test`;
const password = `Two-step ${run} password`;
const uid = randomUUID();

function base32(s: string): Buffer {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += abc.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** A tiny cookie jar: the two-step challenge lives in a cookie between the two requests. */
class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const [k, v] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === "") this.c.delete(k);
      else this.c.set(k, v);
    }
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(prefix: string) {
    return [...this.c.keys()].some((k) => k.includes(prefix));
  }
}

async function call(path: string, body: unknown, jar: Jar) {
  const res = await fetch(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, Cookie: jar.header, "x-jenai-client-ip": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  });
  jar.take(res);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const signedIn = async (jar: Jar) => (await get("/account/security", { cookie: jar.header, email })).status === 200;

let secret = "";
let backup: string[] = [];

beforeAll(async () => {
  if (!(await appUp())) throw new Error(`App not reachable at ${BASE}. Start it with pnpm dev.`);
  await db.insert(user).values({ id: uid, email, name: "Two-step test", emailVerified: true });
  await db.insert(account).values({ id: randomUUID(), accountId: uid, providerId: "credential", userId: uid, password: await hashPassword(password) });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, uid));
});

describe("two-step sign-in", () => {
  it("sets up with a password, a scanned secret and one good code", async () => {
    const jar = new Jar();
    expect((await call("/sign-in/email", { email, password }, jar)).status).toBe(200);
    const wrongPw = await call("/two-factor/enable", { password: "not my password" }, jar);
    expect(wrongPw.status).toBe(400);
    const on = await call("/two-factor/enable", { password }, jar);
    expect(on.status).toBe(200);
    secret = new URL(String(on.body!.totpURI)).searchParams.get("secret")!;
    backup = on.body!.backupCodes as string[];
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(backup).toHaveLength(10);
    // Not on until a code proves the app was set up.
    let [u] = await db.select().from(user).where(eq(user.id, uid));
    expect(u!.twoFactorEnabled).toBe(false);
    expect((await call("/two-factor/verify-totp", { code: totp(secret) }, jar)).status).toBe(200);
    [u] = await db.select().from(user).where(eq(user.id, uid));
    expect(u!.twoFactorEnabled).toBe(true);
    const ev = await db.select().from(securityEvents).where(eq(securityEvents.userId, uid));
    expect(ev.map((e) => e.kind)).toContain("mfa_enabled");
  });

  it("a right password alone no longer opens the account", async () => {
    const jar = new Jar();
    const r = await call("/sign-in/email", { email, password }, jar);
    expect(r.status).toBe(200);
    expect(r.body!.twoFactorRedirect).toBe(true);
    expect(await signedIn(jar)).toBe(false);
  });

  it("refuses a wrong code and records it, then accepts the right one", async () => {
    const jar = new Jar();
    await call("/sign-in/email", { email, password }, jar);
    const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, "0");
    expect((await call("/two-factor/verify-totp", { code: wrong }, jar)).status).toBeGreaterThanOrEqual(400);
    expect(await signedIn(jar)).toBe(false);
    expect((await call("/two-factor/verify-totp", { code: totp(secret) }, jar)).status).toBe(200);
    expect(await signedIn(jar)).toBe(true);
    const kinds = (await db.execute<{ kind: string }>(sql`select kind::text from security_events where created_at > now() - interval '2 minutes' and (user_id = ${uid} or kind = 'mfa_failed') order by id`)).map((e) => e.kind);
    expect(kinds).toContain("mfa_failed");
  });

  it("accepts each backup code once", async () => {
    let jar = new Jar();
    await call("/sign-in/email", { email, password }, jar);
    expect((await call("/two-factor/verify-backup-code", { code: backup[0] }, jar)).status).toBe(200);
    expect(await signedIn(jar)).toBe(true);
    jar = new Jar();
    await call("/sign-in/email", { email, password }, jar);
    expect((await call("/two-factor/verify-backup-code", { code: backup[0] }, jar)).status).toBeGreaterThanOrEqual(400);
    expect(await signedIn(jar)).toBe(false);
  });

  it("stores the secret encrypted, never as the plain key", async () => {
    const [row] = await db.execute<{ secret: string; backup_codes: string }>(sql`select secret, backup_codes from two_factor where user_id = ${uid}`);
    expect(row!.secret).not.toContain(secret);
    expect(row!.backup_codes).not.toContain(backup[1]!);
  });
});
