/** The complaint status lookup at the start of a call, against real Postgres (row-level security on). */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { cases, organizations, platformDb, withTenant } from "@jenai/db";
import { complaintStatusFor, newStatusToken, tenantForStatusToken } from "./voice-status";

let tenant = "";
let other = "";

beforeAll(async () => {
  const make = async (name: string) => {
    const [org] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name, slug: `status-${randomUUID().slice(0, 8)}`, status: "active", languages: ["hi", "en"] })
      .returning({ id: organizations.id });
    return org!.id;
  };
  [tenant, other] = await Promise.all([make("Status Test"), make("Other Police")]);
  await withTenant(tenant, (tx) =>
    tx.insert(cases).values([
      { tenantId: tenant, seq: 1, complainantE164: "+919800000061", status: "taken_up", missing: [], fields: {} },
      { tenantId: tenant, seq: 2, complainantE164: "+919800000062", status: "closed", missing: [], fields: {} },
      // Followed up on another WhatsApp number than the one that called.
      { tenantId: tenant, seq: 3, complainantE164: "+919800000064", status: "collecting", missing: ["pincode"], fields: { caller_number: "+919800000063" } },
    ]),
  );
});
afterAll(async () => {
  for (const id of [tenant, other]) await platformDb().delete(organizations).where(eq(organizations.id, id));
});

describe("complaint status at the start of a call", () => {
  it("says In Progress for a complaint still open from the number calling, and none otherwise", async () => {
    expect(await complaintStatusFor(tenant, "+919800000061")).toBe("In Progress");
    expect(await complaintStatusFor(tenant, "919800000061")).toBe("In Progress"); // the engine's number without +
    expect(await complaintStatusFor(tenant, "+919800000063")).toBe("In Progress"); // called from one number, WhatsApp on another
    expect(await complaintStatusFor(tenant, "+919800000062")).toBe("none"); // closed
    expect(await complaintStatusFor(tenant, "+919800000099")).toBe("none");
    expect(await complaintStatusFor(tenant, "")).toBe("none");
    expect(await complaintStatusFor(other, "+919800000061")).toBe("none"); // another workspace's complaint is never seen
  });

  it("knows the engine only by the newest token, kept here as a hash", async () => {
    const first = await newStatusToken(tenant);
    expect(await tenantForStatusToken(first)).toBe(tenant);
    const second = await newStatusToken(tenant);
    expect(await tenantForStatusToken(first)).toBeNull();
    expect(await tenantForStatusToken(second)).toBe(tenant);
    expect(await tenantForStatusToken("")).toBeNull();
    expect(await tenantForStatusToken("not-a-token")).toBeNull();
  });
});
