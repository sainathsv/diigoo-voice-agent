/**
 * The API the client's own system uses: a button in their CRM asks for a call,
 * then reads what happened. Runs against the app over HTTP, like their code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, calls, carrierAccounts, clientPrograms, organizations, phoneNumbers, platformDb, withTenant } from "@jenai/db";
import { BASE, appUp } from "./harness";

const db = platformDb();
const run = randomUUID().slice(0, 8);
let tenant = "";
let programKey = "";
const made: string[] = [];
/** A different number each run: the standing campaign keeps one row per person. */
const phone = `98${String(Date.now()).slice(-8)}`;

/** A key the way the product makes one: the secret is shown once, only its hash is kept. */
async function makeKey(scopes: string[], name = `test-${run}`) {
  const key = `jk_test_${randomBytes(24).toString("base64url")}`;
  const [row] = await withTenant(tenant, (tx) =>
    tx
      .insert(apiKeys)
      .values({ tenantId: tenant, name, prefix: key.slice(0, 14), keyHash: createHash("sha256").update(key).digest("hex"), scopes })
      .returning(),
  );
  made.push(row!.id);
  return key;
}

const call = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-jenai-client-ip": `10.9.9.${Math.floor(Math.random() * 250)}`,
      ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
      ...(init.headers ?? {}),
    },
  });

beforeAll(async () => {
  if (!(await appUp())) throw new Error(`App not reachable at ${BASE}. Start it with pnpm dev.`);
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, "lbr-dental"));
  tenant = org!.id;
  const [cp] = await withTenant(tenant, (tx) => tx.select().from(clientPrograms));
  if (!cp) throw new Error("LBR has no call program set up; run the programs seed first.");
  programKey = cp.programKey;
  // Give the program a number to call from, declared for AI calls.
  const num = await withTenant(tenant, async (tx) => {
    const [existing] = await tx.select().from(phoneNumbers);
    if (existing) return existing;
    const [acct] = await tx.insert(carrierAccounts).values({ tenantId: tenant, provider: "vobiz", mode: "managed_subaccount", displayName: `api test ${run}` }).returning();
    const [n] = await tx.insert(phoneNumbers).values({ tenantId: tenant, carrierAccountId: acct!.id, e164: "+914022334455", series: "landline", purpose: "both" }).returning();
    return n!;
  });
  await withTenant(tenant, (tx) => tx.update(phoneNumbers).set({ a2pDeclaredAt: new Date(), purpose: "both" }).where(eq(phoneNumbers.id, num.id)));
  await withTenant(tenant, (tx) => tx.update(clientPrograms).set({ callerNumberId: num.id }).where(eq(clientPrograms.id, cp.id)));
});

afterAll(async () => {
  for (const id of made) await withTenant(tenant, (tx) => tx.delete(apiKeys).where(eq(apiKeys.id, id)));
});

describe("the API their system uses", () => {
  it("turns away anyone without a valid key", async () => {
    expect((await call("/api/v1/programs")).status).toBe(401);
    expect((await call("/api/v1/programs", { key: "jk_live_not_a_real_key" })).status).toBe(401);
    const readOnly = await makeKey(["calls:read"]);
    const r = await call("/api/v1/calls", { method: "POST", key: readOnly, body: JSON.stringify({ program: programKey, phone: `${phone.slice(0, 9)}2` }) });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("missing_scope");
  });

  it("lists the programs and what each call needs", async () => {
    const key = await makeKey(["programs:read"]);
    const r = await call("/api/v1/programs", { key });
    expect(r.status).toBe(200);
    const body = await r.json();
    const p = body.programs.find((x: { key: string }) => x.key === programKey);
    expect(p).toBeTruthy();
    expect(p.needs.some((n: { name: string }) => n.name === "appointment_date")).toBe(true);
  });

  it("asks for the missing per-person data instead of calling half-blind", async () => {
    const key = await makeKey(["calls:create"]);
    const r = await call("/api/v1/calls", { method: "POST", key, body: JSON.stringify({ program: programKey, phone: `${phone.slice(0, 9)}1`, name: "Asha" }) });
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.error).toBe("missing_fields");
    expect(body.missing.length).toBeGreaterThan(0);
  });

  it("queues a call, answers with what the rules allow, and counts the same request once", async () => {
    const key = await makeKey(["calls:create", "calls:read"]);
    const body = JSON.stringify({
      program: programKey,
      phone,
      name: "Asha",
      external_id: `THEIR-${run}`,
      idempotency_key: `ticket-${run}`,
      context: { appointment_date: "26 Sep 2026", appointment_time: "11:30 AM", purpose: "cleaning", doctor: "Dr Bhargav", branch: "Ameerpet" },
    });
    const r = await call("/api/v1/calls", { method: "POST", key, body });
    expect(r.status).toBe(202);
    const first = await r.json();
    expect(first.status).toBe("queued");
    expect(typeof first.will_call).toBe("boolean");
    expect(first.outcome_preview.reason).toBeTruthy();

    const again = await call("/api/v1/calls", { method: "POST", key, body });
    expect((await again.json()).status).toBe("duplicate");

    const state = await call(`/api/v1/calls/${first.call_request_id}`, { key });
    expect(state.status).toBe(200);
    const s = await state.json();
    expect(["queued", "scheduled", "not_called", "dialing"]).toContain(s.state);
  });

  it("refuses a program this workspace does not run", async () => {
    const key = await makeKey(["calls:create"]);
    const r = await call("/api/v1/calls", { method: "POST", key, body: JSON.stringify({ program: "municipal.water_sewerage_bill", phone: `${phone.slice(0, 9)}3` }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("unknown_program");
  });

  it("keeps one workspace's key out of another workspace", async () => {
    const key = await makeKey(["calls:read"]);
    const [other] = await db.select().from(organizations).where(eq(organizations.slug, "zennara"));
    const theirs = await withTenant(other!.id, (tx) => tx.select({ id: calls.id }).from(calls).limit(1));
    if (!theirs.length) return; // nothing to try against
    const r = await call(`/api/v1/calls/${theirs[0]!.id}`, { key });
    expect(r.status).toBe(404);
  });
});
