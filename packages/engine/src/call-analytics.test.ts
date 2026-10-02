/** Helpline analytics against real Postgres (row-level security on). */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, calls, cases, organizations, platformDb, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { callAnalytics, parseRupees } from "./call-analytics";
import { isNotCyberCrime, scamKeyFromText } from "./scams";

let tenant = "";

beforeAll(async () => {
  const [org] = await platformDb()
    .insert(organizations)
    .values({ kind: "client", name: "Helpline Test", slug: `helpline-${randomUUID().slice(0, 8)}`, status: "active", languages: ["hi", "en", "ne"] })
    .returning();
  tenant = org!.id;
  await withTenant(tenant, async (tx) => {
    const [cy] = await tx.insert(agents).values({ tenantId: tenant, name: "Cyber line", templateKey: "clinic_receptionist", templateVersion: 2, domain: CYBER_INTAKE_DOMAIN }).returning();
    const [clinic] = await tx.insert(agents).values({ tenantId: tenant, name: "Front desk", templateKey: "clinic_receptionist", templateVersion: 2, domain: "clinic" }).returning();
    const call = (agentId: string, from: string, extracted: Record<string, unknown>, status: "completed" | "in_progress" = "completed") => ({
      tenantId: tenant, agentId, direction: "inbound" as const, status, externalRunId: randomUUID(), fromE164: from, toE164: "+919262102414", startedAt: new Date(), extracted,
    });
    await tx.insert(calls).values([
      call(cy!.id, "+919800000001", { complaint_type: "UPI/bank/card fraud", money_lost: "40000", complainant_name: "Sainath", district: "Dehradun", fraudster_mobile: "9000000001", suspect_account_or_upi: "fraud@upi" }),
      call(cy!.id, "+919800000001", { complaint_type: "UPI fraud", money_lost: "₹10,000", district: "Dehradun" }),
      call(cy!.id, "+919800000002", { complaint_type: "sextortion", danger: "yes", district: "Haridwar" }),
      call(cy!.id, "+919800000003", {}),
      call(cy!.id, "+919800000006", { complaint_type: "not cyber crime", how_it_happened: "Bicycle stolen" }), // not a complaint
      call(cy!.id, "+919800000004", { complaint_type: "job/task scam" }, "in_progress"), // not finished: not counted
      call(clinic!.id, "+919800000005", { concern: "hair fall" }), // another line: never counted
    ]);
  });
});
afterAll(async () => {
  await platformDb().delete(organizations).where(eq(organizations.id, tenant));
});

describe("helpline analytics", () => {
  it("counts finished cyber crime calls by scam, person, money and district", async () => {
    const a = await callAnalytics(tenant, 30);
    expect(a.total).toBe(4);
    expect(a.people).toBe(3);
    expect(a.lostRupees).toBe(50_000);
    expect(a.urgent).toBe(1);
    expect(a.byType[0]).toEqual({ type: "upi_bank_card", count: 2, lostRupees: 50_000 });
    expect(a.byType.find((t) => t.type === null)?.count).toBe(1);
    expect(a.byDistrict[0]).toEqual({ district: "Dehradun", count: 2 });
    const first = a.complaints.find((c) => c.name === "Sainath")!;
    expect(first.fraudster).toBe("9000000001; fraud@upi");
    expect(first.scam).toBe("upi_bank_card");
  });
  it("shows staff limited to a branch only that branch's complaints", async () => {
    expect((await callAnalytics(tenant, 30, { branches: [] })).total).toBe(0);
    expect((await callAnalytics(tenant, 30, { branches: [randomUUID()] })).total).toBe(0);
    expect((await callAnalytics(tenant, 30, { branches: "all" })).total).toBe(4);
  });
  it("reads each call together with what the complainant sent on WhatsApp, and counts WhatsApp-only complaints", async () => {
    const [sainath] = await withTenant(tenant, (tx) => tx.select().from(calls).where(eq(calls.fromE164, "+919800000001")).orderBy(calls.startedAt).limit(1));
    await withTenant(tenant, (tx) =>
      tx.insert(cases).values([
        // Typed on WhatsApp: the corrected name, the father's name, the bank, and "not known" for a line the call left empty.
        { tenantId: tenant, seq: 1, complainantE164: "+919800000001", firstCallId: sainath!.id, scamType: "upi_bank_card", status: "collecting", missing: ["pincode", "proof"], fields: { followup: "questions", complainant_name: "Sainath Tangallapalli", father_or_husband_name: "F: Sadanandam", house_number: "not known" } },
        { tenantId: tenant, seq: 2, complainantE164: "+919800000077", scamType: "investment_trading", status: "ready", missing: [], fields: { followup: "questions", complainant_name: "Asha Negi", money_lost: "75000", district: "Tehri" } },
      ]),
    );
    const a = await callAnalytics(tenant, 30);
    expect(a.total).toBe(5);
    expect(a.lostRupees).toBe(125_000);
    const call = a.complaints.find((c) => c.callId === sainath!.id)!;
    expect(call.name).toBe("Sainath Tangallapalli");
    expect(call.whatsapp).toMatchObject({ followup: "questions", status: "collecting", stillNeeded: 2, proofs: 0 });
    const wa = a.complaints.find((c) => c.callId === null)!;
    expect(wa).toMatchObject({ name: "Asha Negi", scam: "investment_trading", lostRupees: 75_000, district: "Tehri", phone: "+919800000077" });
    expect(a.byDistrict.find((d) => d.district === "Tehri")?.count).toBe(1);
  });

  it("reads amounts the way the analyser writes them", () => {
    expect(parseRupees("40000")).toBe(40_000);
    expect(parseRupees("₹40,000")).toBe(40_000);
    expect(parseRupees("Rs. 40,000")).toBe(40_000);
    expect(parseRupees("2 lakh")).toBe(200_000);
    expect(parseRupees("1.5 crore")).toBe(15_000_000);
    expect(parseRupees("none")).toBe(0);
  });
  it("maps every label the call program asks the analyser for", () => {
    const expected: Record<string, string> = {
      "UPI/bank/card fraud": "upi_bank_card",
      "fake customer care/KYC/APK": "fake_customer_care_kyc_apk",
      "digital arrest": "digital_arrest",
      "investment/trading": "investment_trading",
      "part-time job/task": "part_time_job_task",
      sextortion: "sextortion",
      "loan app harassment": "loan_app",
      "social media hack/fake profile": "social_media_hack_fake_profile",
      "online shopping/fake booking": "online_shopping_fake_booking",
      "lottery/gift/romance": "lottery_gift_romance",
      "SIM swap/AePS": "sim_swap_aeps",
      "online harassment": "online_harassment",
      "hacking/ransomware": "hacking_ransomware",
      other: "other",
    };
    for (const [label, key] of Object.entries(expected)) expect([label, scamKeyFromText(label)]).toEqual([label, key]);
    expect(isNotCyberCrime("not cyber crime")).toBe(true);
    expect(isNotCyberCrime("UPI fraud")).toBe(false);
  });
  it("maps the analyser's fraud types onto the catalogue", () => {
    expect(scamKeyFromText("digital arrest")).toBe("digital_arrest");
    expect(scamKeyFromText("bank account frozen by cyber cell")).toBe("account_frozen");
    expect(scamKeyFromText("something new")).toBe("other");
  });
});
