import "@jenai/db/env";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { platformDb, securityAlerts, securityEvents, type SecurityAlert } from "@jenai/db";
import { detect, judgeAuditEvent } from "./detect";
import { notifyPending, verifyAuditChains } from "./jobs";
import { istHour } from "./time";

const db = platformDb();
const run = randomUUID().slice(0, 8);
const mail = (n: string) => `${n}-${run}@detector.test`;
const ip = (n: number) => `198.51.100.${n}`; // documentation range

async function events(n: number, v: Partial<typeof securityEvents.$inferInsert> & { kind: (typeof securityEvents.$inferInsert)["kind"] }) {
  await db.insert(securityEvents).values(Array.from({ length: n }, () => ({ ...v })));
}
const alertFor = async (key: string) =>
  (await db.select().from(securityAlerts).where(and(eq(securityAlerts.dedupeKey, key), inArray(securityAlerts.status, ["open", "acknowledged"]))))[0];

afterAll(async () => {
  await db.update(securityAlerts).set({ status: "resolved", note: "detector test" }).where(like(securityAlerts.subject, `%${run}%`));
  await db.update(securityAlerts).set({ status: "resolved", note: "detector test" }).where(like(securityAlerts.dedupeKey, `%198.51.100.%`));
  // Sign-in events are append-only (retention drops whole months); test rows use documentation addresses.
});

describe("sign-in detection", () => {
  it("flags repeated wrong passwords on one account, then raises it to high on a lockout", async () => {
    const e = mail("owner");
    await events(5, { kind: "signin_failed", email: e, ip: ip(1) });
    await detect(db);
    let a = await alertFor(`signin.account_guessing:${e}`);
    expect(a?.severity).toBe("medium");
    expect(a?.hits).toBe(5);
    await events(1, { kind: "signin_locked", email: e, ip: ip(1) });
    await detect(db);
    a = await alertFor(`signin.account_guessing:${e}`);
    expect(a?.severity).toBe("high");
    expect(a?.hits).toBe(6); // same alert, not a second one
    expect((await db.select().from(securityAlerts).where(eq(securityAlerts.dedupeKey, `signin.account_guessing:${e}`))).length).toBe(1);
  });

  it("ignores a couple of typos", async () => {
    const e = mail("typo");
    await events(2, { kind: "signin_failed", email: e, ip: ip(2) });
    await detect(db);
    expect(await alertFor(`signin.account_guessing:${e}`)).toBeUndefined();
  });

  it("flags one address trying many accounts (password spraying)", async () => {
    const addr = ip(50 + Math.floor(Math.random() * 150));
    for (const n of ["a", "b", "c", "d", "e"]) await events(1, { kind: "signin_failed", email: mail(`spray-${n}`), ip: addr });
    await detect(db);
    expect((await alertFor(`signin.password_spray:${addr}`))?.severity).toBe("high");
  });

  it("flags a success that follows a run of failures", async () => {
    const e = mail("guessed");
    await events(5, { kind: "signin_failed", email: e, ip: ip(3) });
    await events(1, { kind: "signin_ok", email: e, ip: ip(3), userId: "u-guessed" });
    const r = await detect(db);
    expect(r.raised.some((c) => c.rule === "signin.success_after_failures" && c.subject === e)).toBe(true);
  });

  it("flags someone probing for records they cannot open", async () => {
    const uid = `probe-${run}`;
    await events(10, { kind: "access_denied", userId: uid, detail: { missing: "x" } });
    await detect(db);
    expect((await alertFor(`access.probing:${uid}`))?.severity).toBe("high");
  });
});

describe("two-step sign-in rules", () => {
  it("flags wrong 2-step codes after a right password from the same address", async () => {
    const addr = ip(40);
    const e = mail("stolen");
    await events(1, { kind: "signin_ok", email: e, ip: addr, detail: { stage: "password", twoStep: "pending" } });
    await events(3, { kind: "mfa_failed", ip: addr, detail: { method: "authenticator" } });
    await detect(db);
    const a = await alertFor(`signin.two_step_failing:${addr}`);
    expect(a?.severity).toBe("high");
    expect(a?.subject).toContain(e);
  });
  it("flags two-step sign-in being turned off", async () => {
    await events(1, { kind: "mfa_disabled", email: mail("off"), userId: `u-off-${run}` });
    const r = await detect(db);
    expect(r.raised.find((c) => c.rule === "signin.two_step_disabled" && c.subject === mail("off"))?.severity).toBe("medium");
  });
});

describe("audit-log rules", () => {
  const row = (action: string, extra: Partial<Parameters<typeof judgeAuditEvent>[0]> = {}) => ({
    id: 1, tenant_id: "t1", actor_user_id: "u1", via: "user", action, summary: action, diff: null, ip: null,
    created_at: new Date("2026-09-19T06:30:00Z"), // 12:00 in India
    actor_email: "someone@test", platform_actor: false, ...extra,
  });

  it("treats every break-glass use as critical", () => {
    expect(judgeAuditEvent(row("support.breakglass"))[0]?.severity).toBe("critical");
    expect(judgeAuditEvent(row("support.session_started", { diff: { mode: "breakglass" } })).map((c) => c.rule)).toContain("support.breakglass");
  });

  it("flags support sessions and admin changes outside 08:00-21:00 India time", () => {
    const night = new Date("2026-09-19T20:00:00Z"); // 01:30 IST
    expect(istHour(night)).toBe(1);
    expect(judgeAuditEvent(row("support.session_started", { created_at: night, diff: { mode: "read" } })).map((c) => c.rule)).toContain("support.off_hours");
    expect(judgeAuditEvent(row("plan.updated", { created_at: night })).map((c) => c.rule)).toContain("admin.off_hours");
    expect(judgeAuditEvent(row("plan.updated"))).toHaveLength(0);
    expect(judgeAuditEvent(row("plan.updated", { created_at: night, via: "system" }))).toHaveLength(0);
  });

  it("flags admin-level access being handed out, not ordinary roles", () => {
    expect(judgeAuditEvent(row("member.role_added", { diff: { roleKey: "front_desk", privileged: [] } }))).toHaveLength(0);
    const owner = judgeAuditEvent(row("member.role_added", { diff: { roleKey: "owner", privileged: ["org:manage", "org:transfer_ownership"] } }));
    expect(owner[0]?.rule).toBe("roles.privilege_granted");
    expect(owner[0]?.severity).toBe("high");
    expect(judgeAuditEvent(row("role.updated", { diff: { added: ["calls:view", "apikeys:manage"], removed: [] } }))[0]?.detail.permissions).toEqual(["apikeys:manage"]);
    expect(judgeAuditEvent(row("role.updated", { diff: { added: ["calls:view"], removed: [] } }))).toHaveLength(0);
  });

  it("flags changes to a client's voice engine connection", () => {
    expect(judgeAuditEvent(row("voice.mode_changed"))[0]?.severity).toBe("high");
    expect(judgeAuditEvent(row("voice.connection_saved"))[0]?.severity).toBe("medium");
  });
});

describe("integrity and notifications", () => {
  it("verifies every audit chain and ships the heads to the log", async () => {
    const lines: string[] = [];
    const checks = await verifyAuditChains(db, (l) => lines.push(l));
    expect(checks.every((c) => c.problem === null)).toBe(true);
    const anchor = JSON.parse(lines[0]!);
    expect(anchor.type).toBe("audit_anchor");
    expect(anchor.root).toMatch(/^[0-9a-f]{64}$/);
    // Nothing new since: the next pass has no incremental work.
    const again = await verifyAuditChains(db, () => {}, { fullShard: false });
    expect(again).toHaveLength(0);
  });

  it("sends each high or critical alert once", async () => {
    const sent: SecurityAlert[] = [];
    const fake = { send: async (a: SecurityAlert) => void sent.push(a) };
    await notifyPending(db, fake);
    const mine = sent.filter((a) => a.subject.includes(run) || a.subject.startsWith("198.51.100."));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.severity === "high" || a.severity === "critical")).toBe(true);
    sent.length = 0;
    await notifyPending(db, fake);
    expect(sent.filter((a) => a.subject.includes(run))).toHaveLength(0);
  });
});
