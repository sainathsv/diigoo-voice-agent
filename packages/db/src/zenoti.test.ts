/**
 * What JENAI reads from a clinic's front desk system (migration 0030): its
 * people, bookings and package balances, and visits read from it. Each keeps
 * to its own client, the way every other tenant table does. Runs as the app
 * role against the local database. Requires `pnpm db:migrate` first.
 */
import "./scripts/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { platformDb, withTenant } from "./client";
import { clinicAppointments, externalPeople, integrations, organizations, packageBalances, plannedCalls, visits } from "./schema";

let a = "";
let b = "";
let zenotiA = "";
const GUEST = "6c0f2a4e-0b1d-4b8e-9d55-3f5a1c2e7d90";

/** Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is on .cause. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.cause?.message ?? ""} ${err.message ?? ""}`;
  }
  return "no error";
}

beforeAll(async () => {
  const made = await platformDb()
    .insert(organizations)
    .values(["A", "B"].map((n) => ({ kind: "client" as const, name: `Front Desk Clinic ${n}`, slug: `zenoti-test-${n.toLowerCase()}-${randomUUID().slice(0, 8)}`, status: "active" as const, vertical: "dermatology", languages: ["en"] })))
    .returning({ id: organizations.id });
  a = made[0]!.id;
  b = made[1]!.id;
  const [i] = await withTenant(a, (tx) => tx.insert(integrations).values({ tenantId: a, kind: "zenoti", name: "Zenoti", direction: "in" }).returning());
  zenotiA = i!.id;
});

afterAll(async () => {
  await platformDb().delete(organizations).where(inArray(organizations.id, [a, b]));
});

const counts = (tenant: string) =>
  withTenant(tenant, async (tx) => ({
    people: (await tx.select().from(externalPeople)).length,
    bookings: (await tx.select().from(clinicAppointments)).length,
    packages: (await tx.select().from(packageBalances)).length,
    visits: (await tx.select().from(visits)).length,
  }));

describe("front desk tables", () => {
  it("keep each client's people, bookings, packages and visits to that client", async () => {
    await withTenant(a, async (tx) => {
      await tx.insert(externalPeople).values({ tenantId: a, integrationId: zenotiA, externalId: GUEST, phoneE164: "+919876543210", name: "Guest", marketingSmsConsent: false, transactionalSmsConsent: true });
      await tx.insert(clinicAppointments).values({
        tenantId: a, integrationId: zenotiA, externalId: randomUUID(), guestRef: GUEST, phoneE164: "+919876543210",
        service: "Laser Hair Reduction", category: "Laser", startsAt: new Date("2026-10-05T05:30:00Z"), status: "booked", doctor: "Dr Rao", centreRef: randomUUID(),
      });
      await tx.insert(packageBalances).values({
        tenantId: a, integrationId: zenotiA, guestRef: GUEST, packageRef: randomUUID(), packageName: "LHR 5 Body Parts 5 Sessions", service: "LHR Full Legs",
        total: 5, used: 2, balance: 3, status: "active", expiresOn: "2027-03-31",
      });
      // From their sales report, which names the guest but carries no number yet.
      await tx.insert(visits).values({ tenantId: a, integrationId: zenotiA, externalId: "invoice-item-1", guestRef: GUEST, service: "LHR Full Legs", visitDate: "2026-09-30", source: "api" });
    });

    expect(await counts(a)).toEqual({ people: 1, bookings: 1, packages: 1, visits: 1 });
    expect(await counts(b)).toEqual({ people: 0, bookings: 0, packages: 0, visits: 0 });

    const [p] = await withTenant(a, (tx) => tx.select().from(packageBalances));
    expect(p).toMatchObject({ total: 5, used: 2, balance: 3, expiresOn: "2027-03-31" });
    const [v] = await withTenant(a, (tx) => tx.select().from(visits));
    expect(v).toMatchObject({ phoneE164: null, guestRef: GUEST, integrationId: zenotiA });
  });

  it("refuses a row written into another client, and hides one asked for by id", async () => {
    for (const write of [
      () => withTenant(b, (tx) => tx.insert(externalPeople).values({ tenantId: a, integrationId: zenotiA, externalId: randomUUID() })),
      () => withTenant(b, (tx) => tx.insert(clinicAppointments).values({ tenantId: a, integrationId: zenotiA, externalId: randomUUID(), guestRef: GUEST, service: "x", startsAt: new Date(), status: "booked" })),
      () => withTenant(b, (tx) => tx.insert(packageBalances).values({ tenantId: a, integrationId: zenotiA, guestRef: GUEST, packageName: "x", service: "y", status: "active" })),
    ]) {
      expect(await pgError(write())).toMatch(/row-level security/i);
    }
    expect(await withTenant(b, (tx) => tx.select().from(externalPeople).where(eq(externalPeople.tenantId, a)))).toHaveLength(0);
    const changed = await withTenant(b, (tx) => tx.update(clinicAppointments).set({ status: "cancelled" }).where(eq(clinicAppointments.tenantId, a)).returning());
    expect(changed).toHaveLength(0);
  });

  it("keeps one row per thing in their system, so reading it again updates rather than doubles", async () => {
    const [booking] = await withTenant(a, (tx) => tx.select().from(clinicAppointments));
    for (const again of [
      () => withTenant(a, (tx) => tx.insert(externalPeople).values({ tenantId: a, integrationId: zenotiA, externalId: GUEST })),
      () => withTenant(a, (tx) => tx.insert(clinicAppointments).values({ ...booking!, id: undefined })),
      () => withTenant(a, (tx) => tx.insert(packageBalances).values({ tenantId: a, integrationId: zenotiA, guestRef: GUEST, packageName: "LHR 5 Body Parts 5 Sessions", service: "LHR Full Legs", status: "active" })),
      () => withTenant(a, (tx) => tx.insert(visits).values({ tenantId: a, integrationId: zenotiA, externalId: "invoice-item-1", guestRef: GUEST, service: "LHR Full Legs", visitDate: "2026-09-30" })),
    ]) {
      expect(await pgError(again())).toMatch(/duplicate key/i);
    }
  });

  it("stores only the statuses it knows, and a visit with no number only when it can still get one", async () => {
    const odd = withTenant(a, (tx) =>
      tx.insert(clinicAppointments).values({ tenantId: a, integrationId: zenotiA, externalId: randomUUID(), guestRef: GUEST, service: "x", startsAt: new Date(), status: "dial" as "booked" }),
    );
    expect(await pgError(odd)).toMatch(/check constraint/i);
    const oddPackage = withTenant(a, (tx) => tx.insert(packageBalances).values({ tenantId: a, integrationId: zenotiA, guestRef: randomUUID(), packageName: "x", service: "y", status: "open" as "active" }));
    expect(await pgError(oddPackage)).toMatch(/check constraint/i);
    // An uploaded visit has always had its number; one with neither number nor person could never be called.
    const noOne = withTenant(a, (tx) => tx.insert(visits).values({ tenantId: a, service: "Hydrafacial", visitDate: "2026-09-30" }));
    expect(await pgError(noOne)).toMatch(/visits_phone_or_guest/);
  });

  it("leaves uploaded visits free of the connection's ids, and drops the connection's copy, its planned calls included, when it is removed", async () => {
    // Two uploads carry no external id, so the connection's uniqueness does not touch them.
    const uploaded = await withTenant(a, (tx) =>
      tx
        .insert(visits)
        .values([
          { tenantId: a, phoneE164: "+919876543211", service: "Hydrafacial", visitDate: "2026-09-29" },
          { tenantId: a, phoneE164: "+919876543212", service: "Hydrafacial", visitDate: "2026-09-29" },
        ])
        .returning(),
    );
    // The plan made from what the connection read names people, numbers and treatments.
    await withTenant(a, async (tx) => {
      const [booking] = await tx.select().from(clinicAppointments);
      const [line] = await tx.select().from(visits).where(eq(visits.integrationId, zenotiA));
      const row = (originType: "visit" | "clinic_appointment", originId: string) => ({
        tenantId: a,
        journey: "next_session",
        programKey: "clinic.revisit_recall",
        verdict: "scheduled" as const,
        reason: "Session 4 of 5 of LHR Full Legs is next",
        originType,
        originId,
        originLabel: "Zenoti",
        phoneE164: "+919876543210",
        name: "Guest",
      });
      await tx.insert(plannedCalls).values([row("clinic_appointment", booking!.id), row("visit", line!.id), row("visit", uploaded[0]!.id)]);
    });
    await withTenant(a, (tx) => tx.delete(integrations).where(eq(integrations.id, zenotiA)));
    expect(await counts(a)).toEqual({ people: 0, bookings: 0, packages: 0, visits: 2 });
    // Only the uploaded visit's planned call is left.
    expect((await withTenant(a, (tx) => tx.select().from(plannedCalls))).map((p) => p.originId)).toEqual([uploaded[0]!.id]);
  });
});
