/**
 * Blue team, end to end: attacks leave a trail, the detector turns the trail
 * into alerts, and only people with the security permission can handle them.
 * Needs the app running (pnpm dev) and the seeded database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { platformDb, securityAlerts, securityEvents } from "@jenai/db";
import { detect } from "@jenai/engine";
import { BASE, appUp, findAction, get, login, postAction, type Session } from "./harness";

const db = platformDb();
/** The flash message a redirect carries (?ok= or ?error=). */
const msg = (location: string) => {
  const q = new URL(location, BASE).searchParams;
  return q.get("ok") ?? q.get("error") ?? "";
};
const run = randomUUID().slice(0, 8);
const ghost = `ghost-${run}@nowhere.test`;
const attackerIp = `203.0.113.${randomInt(1, 250)}`;
let founder: Session;
let support: Session;
let frontdesk: Session;

beforeAll(async () => {
  if (!(await appUp())) throw new Error(`App not reachable at ${BASE}. Start it with pnpm dev.`);
  founder = await login("founder@diigoo.test");
  support = await login("support@diigoo.test");
  frontdesk = await login("frontdesk@zennara.test");
});

afterAll(async () => {
  await db.update(securityAlerts).set({ status: "resolved", note: "blue-team test" }).where(and(like(securityAlerts.subject, `%${run}%`), sql`${securityAlerts.status} in ('open', 'acknowledged')`));
});

async function wrongPasswords(n: number) {
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE, "x-jenai-client-ip": attackerIp },
      body: JSON.stringify({ email: ghost, password: `guess-${i}-${run}` }),
    });
    expect(r.status).toBe(401);
  }
}

describe("detection and response", () => {
  let alertId = "";

  it("records every wrong password with the address it came from", async () => {
    await wrongPasswords(5);
    const rows = await db.select().from(securityEvents).where(eq(securityEvents.email, ghost));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.kind === "signin_failed" && r.ip === attackerIp)).toBe(true);
  });

  it("turns the burst into an alert on the Security page", async () => {
    await detect(db);
    const [a] = await db.select().from(securityAlerts).where(eq(securityAlerts.dedupeKey, `signin.account_guessing:${ghost}`));
    expect(a?.status).toBe("open");
    alertId = a!.id;
    const page = await get("/console/security", founder);
    expect(page.status).toBe(200);
    expect(page.text).toContain(ghost);
  });

  it("keeps the Security page and its buttons away from staff without the permission", async () => {
    const page = await get("/console/security", support);
    expect(page.status).toBe(307);
    expect(page.location).toContain("/console?denied=platform%3Asecurity.view");
    const client = await get("/console/security", frontdesk);
    expect(client.location).toContain("/orgs");

    // Replaying the founder's button with the support agent's session changes nothing.
    const html = (await get("/console/security", founder)).text;
    const action = findAction(html, ["id", "decision"]);
    const r = await postAction("/console/security", action, { id: alertId, decision: "false_positive", note: "trying to hide it" }, support);
    expect(r.location).toContain("denied");
    const [a] = await db.select().from(securityAlerts).where(eq(securityAlerts.id, alertId));
    expect(a!.status).toBe("open");
    // ...and the attempt itself is on record.
    const denials = await db.select().from(securityEvents).where(and(eq(securityEvents.kind, "access_denied"), sql`${securityEvents.detail}->>'perm' = 'platform:security.manage'`));
    expect(denials.length).toBeGreaterThan(0);
  });

  it("lets a super admin acknowledge, and insists on a note before closing", async () => {
    const html = (await get("/console/security", founder)).text;
    const action = findAction(html, ["id", "decision"]);
    let r = await postAction("/console/security", action, { id: alertId, decision: "acknowledge" }, founder);
    expect(msg(r.location)).toContain("Alert acknowledged");
    r = await postAction("/console/security", action, { id: alertId, decision: "resolve", note: "" }, founder);
    expect(msg(r.location)).toContain("short note");
    r = await postAction("/console/security", action, { id: alertId, decision: "resolve", note: `Blue-team drill ${run}` }, founder);
    expect(msg(r.location)).toContain("Alert resolved");
    const [a] = await db.select().from(securityAlerts).where(eq(securityAlerts.id, alertId));
    expect(a!.status).toBe("resolved");
    expect(a!.note).toContain(run);
    const audit = await db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${alertId} order by id`);
    expect(audit.map((x) => x.action)).toEqual(["security.alert_acknowledge", "security.alert_resolve"]);
  });

  it("flags a client user probing for other clients' records", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await get(`/w/zennara/calls/${randomUUID()}`, frontdesk);
      expect(r.status).toBe(404);
    }
    const r = await detect(db);
    expect(r.raised.some((c) => c.rule === "access.probing" && c.subject === "frontdesk@zennara.test")).toBe(true);
    // Leave no open alert behind for the dev console.
    await db.update(securityAlerts).set({ status: "resolved", note: `blue-team test ${run}` }).where(and(eq(securityAlerts.rule, "access.probing"), eq(securityAlerts.subject, "frontdesk@zennara.test")));
  });

  it("runs the activity-log check from the page", async () => {
    const html = (await get("/console/security", founder)).text;
    const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]!).find((f) => f.includes("Check now"));
    const id = form?.match(/name="(\$ACTION_ID_[0-9a-f]+)"/)?.[1];
    expect(id).toBeTruthy();
    const r = await postAction("/console/security", id!, {}, founder);
    expect(msg(r.location)).toContain("Activity log intact");
  });
});
