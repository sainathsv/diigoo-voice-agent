/** Helpline analytics against real Postgres (row-level security on). */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, calls, organizations, platformDb, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { callAnalytics } from "./call-analytics";
import { scamKeyFromText } from "./scams";

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
  it("maps the analyser's fraud types onto the catalogue", () => {
    expect(scamKeyFromText("digital arrest")).toBe("digital_arrest");
    expect(scamKeyFromText("bank account frozen by cyber cell")).toBe("account_frozen");
    expect(scamKeyFromText("something new")).toBe("other");
  });
});
