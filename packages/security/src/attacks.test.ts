/**
 * RED TEAM: automated attacks against the running app (OWASP Top 10 focus).
 * Every test is phrased as the attack; it passes when the attack FAILS.
 * Run: pnpm dev (in another terminal), then pnpm --filter @jenai/security attack
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  branches,
  calls,
  campaigns,
  carrierAccounts,
  contacts,
  leads,
  memberships,
  organizations,
  phoneNumbers,
  platformDb,
  roleBindings,
  roles,
  supportGrants,
  user,
  agentTemplates,
} from "@jenai/db";
import { BASE, appUp, findAction, get, login, postAction, type Session } from "./harness";

const db = platformDb();
let zen = "";
let lbr = "";
const ids: Record<string, string> = {};
let owner: Session, admin: Session, frontdesk: Session, manager: Session, support: Session, lbrOwner: Session;

async function orgId(slug: string) {
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return o!.id;
}

beforeAll(async () => {
  if (!(await appUp())) throw new Error(`App not reachable at ${BASE}. Start it with pnpm dev.`);
  zen = await orgId("zennara");
  lbr = await orgId("lbr-dental");
  // LBR resources the Zennara side must never reach.
  const [c] = await db.insert(contacts).values({ tenantId: lbr, phoneE164: "+919800000901", name: "LBR Patient", tags: [] }).onConflictDoUpdate({ target: [contacts.tenantId, contacts.phoneE164], set: { name: "LBR Patient" } }).returning();
  const [l] = await db.insert(leads).values({ tenantId: lbr, contactId: c!.id, stage: "new", interest: "implants" }).returning();
  const [call] = await db.insert(calls).values({ tenantId: lbr, direction: "inbound", status: "completed", externalRunId: `attack-${Date.now()}`, startedAt: new Date(), recordingRef: "https://example.invalid/rec.wav", extracted: {} }).returning();
  const [tpl] = await db.select().from(agentTemplates).limit(1);
  const [a] = await db.insert(agents).values({ tenantId: lbr, name: "LBR agent (attack fixture)", templateKey: tpl!.key, templateVersion: tpl!.version }).returning();
  const [acct] = await db.insert(carrierAccounts).values({ tenantId: lbr, provider: "vobiz", mode: "managed_subaccount", displayName: "attack fixture" }).returning();
  const [num] = await db.insert(phoneNumbers).values({ tenantId: lbr, carrierAccountId: acct!.id, e164: `+9140${Date.now().toString().slice(-8)}`, series: "landline", purpose: "both" }).returning();
  const [camp] = await db.insert(campaigns).values({ tenantId: lbr, agentId: a!.id, callerNumberId: num!.id, name: "LBR attack fixture", purpose: "service", windows: { days: [1], start: "10:00", end: "18:00" } }).returning();
  // A Zennara lead so the leads page renders the update form an attacker would harvest.
  const [zc] = await db.insert(contacts).values({ tenantId: zen, phoneE164: "+919800000902", name: "Zennara fixture", tags: [] }).onConflictDoUpdate({ target: [contacts.tenantId, contacts.phoneE164], set: { name: "Zennara fixture" } }).returning();
  const [zl] = await db.insert(leads).values({ tenantId: zen, contactId: zc!.id, stage: "new", interest: "fixture" }).onConflictDoNothing().returning();
  if (zl) ids.zenLead = zl.id;
  Object.assign(ids, { lbrContact: c!.id, lbrLead: l!.id, lbrCall: call!.id, lbrAgent: a!.id, lbrCampaign: camp!.id, lbrAcct: acct!.id, lbrNum: num!.id });

  [owner, admin, frontdesk, manager, support, lbrOwner] = await Promise.all([
    login("owner@zennara.test"),
    login("admin@zennara.test"),
    login("frontdesk@zennara.test"),
    login("manager@zennara.test"),
    login("support@diigoo.test"),
    login("owner@lbr.test"),
  ]);
});

afterAll(async () => {
  await db.delete(campaigns).where(eq(campaigns.id, ids.lbrCampaign!));
  await db.delete(phoneNumbers).where(eq(phoneNumbers.id, ids.lbrNum!));
  await db.delete(carrierAccounts).where(eq(carrierAccounts.id, ids.lbrAcct!));
  await db.delete(agents).where(eq(agents.id, ids.lbrAgent!));
  await db.delete(calls).where(eq(calls.id, ids.lbrCall!));
  await db.delete(leads).where(eq(leads.id, ids.lbrLead!));
  if (ids.zenLead) await db.delete(leads).where(eq(leads.id, ids.zenLead));
  await db.delete(branches).where(eq(branches.name, "<img src=x onerror=alert(1)>"));
});

describe("A01 broken access control: reaching another client's data", () => {
  it("cannot open another client's call, agent or campaign by id", async () => {
    for (const p of [`/w/zennara/calls/${ids.lbrCall}`, `/w/zennara/agents/${ids.lbrAgent}`, `/w/zennara/campaigns/${ids.lbrCampaign}`]) {
      expect((await get(p, owner)).status, p).toBe(404);
    }
  });
  it("cannot open another client's workspace by changing the URL", async () => {
    expect((await get(`/w/lbr-dental/calls/${ids.lbrCall}`, owner)).status).toBe(404);
    expect((await get(`/w/lbr-dental`, owner)).status).toBe(404);
  });
  it("cannot stream another client's recording through the API", async () => {
    expect((await get(`/api/w/zennara/calls/${ids.lbrCall}/recording`, owner)).status).toBe(404);
    expect((await get(`/api/w/lbr-dental/calls/${ids.lbrCall}/recording`, owner)).status).toBe(404);
  });
  it("cannot change another client's lead by replaying a form with its id", async () => {
    const page = await get("/w/zennara/leads", owner);
    const action = findAction(page.text, ["slug", "id", "stage"]);
    const r = await postAction("/w/zennara/leads", action, { slug: "zennara", id: ids.lbrLead!, stage: "lost", lostReason: "attack", back: "leads" }, owner);
    expect(r.status).toBeLessThan(500);
    const [l] = await db.select().from(leads).where(eq(leads.id, ids.lbrLead!));
    expect(l!.stage).toBe("new");
  });
  it("cannot act on another client by putting its slug in the form", async () => {
    const team = await get("/w/zennara/branches", owner);
    const action = findAction(team.text, ["slug", "name", "city"]);
    const before = await db.select().from(branches).where(eq(branches.tenantId, lbr));
    await postAction("/w/zennara/branches", action, { slug: "lbr-dental", name: "Injected by Zennara owner", city: "x" }, owner);
    const after = await db.select().from(branches).where(eq(branches.tenantId, lbr));
    expect(after.length).toBe(before.length);
  });
});

describe("A01 privilege escalation", () => {
  it("front desk cannot grant itself the Owner role", async () => {
    const team = await get("/w/zennara/team", owner);
    const action = findAction(team.text, ["slug", "membershipId", "roleId", "branchId"]);
    const [fd] = await db.select({ m: memberships }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(and(eq(memberships.tenantId, zen), eq(user.email, "frontdesk@zennara.test")));
    const [ownerRole] = await db.select().from(roles).where(and(eq(roles.key, "owner"), eq(roles.side, "client")));
    await postAction("/w/zennara/team", action, { slug: "zennara", membershipId: fd!.m.id, roleId: ownerRole!.id, branchId: "" }, frontdesk);
    const got = await db.select().from(roleBindings).where(and(eq(roleBindings.membershipId, fd!.m.id), eq(roleBindings.roleId, ownerRole!.id)));
    expect(got).toHaveLength(0);
  });
  it("an Admin cannot make someone an Owner", async () => {
    const team = await get("/w/zennara/team", admin);
    const action = findAction(team.text, ["slug", "membershipId", "roleId", "branchId"]);
    const [mk] = await db.select({ m: memberships }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(and(eq(memberships.tenantId, zen), eq(user.email, "marketing@zennara.test")));
    const [ownerRole] = await db.select().from(roles).where(and(eq(roles.key, "owner"), eq(roles.side, "client")));
    await postAction("/w/zennara/team", action, { slug: "zennara", membershipId: mk!.m.id, roleId: ownerRole!.id, branchId: "" }, admin);
    const got = await db.select().from(roleBindings).where(and(eq(roleBindings.membershipId, mk!.m.id), eq(roleBindings.roleId, ownerRole!.id)));
    expect(got).toHaveLength(0);
  });
  it("a branch manager cannot hand out organization-wide Admin", async () => {
    const team = await get("/w/zennara/team", manager);
    const action = findAction(team.text, ["slug", "membershipId", "roleId", "branchId"]);
    const [mk] = await db.select({ m: memberships }).from(memberships).innerJoin(user, eq(user.id, memberships.userId)).where(and(eq(memberships.tenantId, zen), eq(user.email, "marketing@zennara.test")));
    const [adminRole] = await db.select().from(roles).where(and(eq(roles.key, "admin"), eq(roles.side, "client")));
    await postAction("/w/zennara/team", action, { slug: "zennara", membershipId: mk!.m.id, roleId: adminRole!.id, branchId: "" }, manager);
    const got = await db.select().from(roleBindings).where(and(eq(roleBindings.membershipId, mk!.m.id), eq(roleBindings.roleId, adminRole!.id)));
    expect(got).toHaveLength(0);
  });
  it("support staff cannot enter a workspace with someone else's grant id", async () => {
    const [grant] = await db.select().from(supportGrants).where(eq(supportGrants.tenantId, zen)).limit(1);
    const forged = { ...support, cookie: `${support.cookie}; jenai_support=${grant?.id ?? "00000000-0000-0000-0000-000000000000"}` };
    expect((await get("/w/zennara", forged)).status).toBe(404);
  });
  it("client users cannot open the Diigoo console", async () => {
    for (const s of [owner, lbrOwner]) {
      const r = await get("/console", s);
      expect(r.status).toBe(307);
      expect(r.location).toContain("/orgs");
    }
  });
});

describe("A01/A04 cross-site request forgery", () => {
  it("rejects a server action posted from another site", async () => {
    const page = await get("/w/zennara/branches", owner);
    const action = findAction(page.text, ["slug", "name", "city"]);
    const before = (await db.select().from(branches).where(eq(branches.tenantId, zen))).length;
    const r = await postAction("/w/zennara/branches", action, { slug: "zennara", name: "CSRF branch", city: "x" }, owner, { Origin: "https://evil.example" });
    const after = (await db.select().from(branches).where(eq(branches.tenantId, zen))).length;
    expect(after).toBe(before);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("A03 injection and cross-site scripting", () => {
  it("does not crash on hostile filter values", async () => {
    for (const p of ["/w/zennara/calls?status=' OR '1'='1", "/w/zennara/calls?direction=x';--", "/w/zennara/leads?stage=%00%27", "/w/zennara/calls?branch=not-a-uuid", "/w/zennara/calls?page=-5"]) {
      const r = await get(p, owner);
      expect(r.status, p).toBeLessThan(500);
    }
  });
  it("escapes stored HTML instead of running it", async () => {
    const page = await get("/w/zennara/branches", owner);
    const action = findAction(page.text, ["slug", "name", "city"]);
    await postAction("/w/zennara/branches", action, { slug: "zennara", name: "<img src=x onerror=alert(1)>", city: "x" }, owner);
    const after = await get("/w/zennara/branches", owner);
    expect(after.text).not.toContain("<img src=x onerror=alert(1)>");
    expect(after.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("A07 identification and authentication", () => {
  it("public sign-up is closed", async () => {
    const r = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email: "attacker@evil.example", password: "Attacker123!!", name: "x" }) });
    expect(r.status).not.toBe(200);
  });
  it("session cookies are HttpOnly and SameSite", async () => {
    const r = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "x-jenai-client-ip": "10.9.9.9" }, body: JSON.stringify({ email: "analyst-none@zennara.test", password: "x" }) });
    expect(r.status).not.toBe(200);
    const s = await login("admin@zennara.test");
    const res = await fetch(`${BASE}/api/auth/get-session`, { headers: { Cookie: s.cookie } });
    expect(res.status).toBe(200);
    const raw = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "x-jenai-client-ip": "10.8.8.8" }, body: JSON.stringify({ email: "admin@zennara.test", password: process.env.SEED_PASSWORD }) });
    const setCookie = raw.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
  it("a signed-out session cannot be reused", async () => {
    const s = await login("analyst-check@jenai.test").catch(() => login("consultant@jenai.test"));
    const out = await fetch(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { Cookie: s.cookie, Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    const r = await get("/w/zennara", s);
    expect(r.status).toBe(307);
    expect(r.location).toContain("/login");
  });
  it("a forged X-Forwarded-For does not reset the sign-in limit", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "x-jenai-client-ip": "10.77.77.77", "X-Forwarded-For": `1.2.3.${i}` }, body: JSON.stringify({ email: `nobody${i}@x.test`, password: "wrong-password" }) });
      codes.push(r.status);
    }
    expect(codes).toContain(429);
  });
});

describe("A05 security misconfiguration: browser protections", () => {
  it("sends the protective headers on every page", async () => {
    const r = await get("/login");
    const h = r.headers;
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBeTruthy();
    expect(h.get("permissions-policy")).toBeTruthy();
    expect(h.get("x-powered-by")).toBeNull();
    const csp = h.get("content-security-policy") ?? "";
    expect(csp, "Content-Security-Policy").toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
