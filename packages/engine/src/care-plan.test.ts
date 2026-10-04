/**
 * The call plan: which call JENAI would make to each person, when and why,
 * or why not. planPerson() is pure and tested on its own; replanTenant() runs
 * against the local database (`pnpm db:migrate` first).
 *
 * Times are India's. 1 Oct 2026 is a Thursday; 4 Oct a Sunday.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  campaignTargets,
  calls,
  clientPrograms,
  crmRecords,
  integrationEvents,
  integrations,
  organizations,
  plannedCalls,
  platformDb,
  suppressions,
  visits,
  withTenant,
} from "@jenai/db";
import {
  DEFAULT_PLAN_SETTINGS,
  planPerson,
  planSettingsOf,
  replanTenant,
  ruleFor,
  treatmentRulesFor,
  type PlanPerson,
  type PlanRecord,
  type PlanRow,
  type PlanVisit,
} from "./care-plan";
import { callbackFromNotes } from "./integrations/zoho";

const ist = (s: string) => new Date(`${s.replace(" ", "T")}:00+05:30`);
const NOW = ist("2026-10-01 12:00");
const PHONE = "+919876543210";
const RULES = treatmentRulesFor([], "dermatology");
const COLD = "Older than 30 days counts as a cold call, which needs a promotional number and consent.";
const NOT_SET_UP = " (call script not added to this workspace yet)";

let n = 0;
const lead = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  id: `lead-${++n}`,
  module: "Leads",
  crm: "Zoho",
  phoneE164: PHONE,
  name: "Anitha",
  status: "New Lead",
  createdExt: ist("2026-09-29 11:00"),
  ...over,
});
const visit = (over: Partial<PlanVisit> = {}): PlanVisit => ({ id: `visit-${++n}`, phoneE164: PHONE, name: "Anitha", service: "Hydrafacial", visitDate: "2026-09-30", ...over });
const plan = (p: Partial<PlanPerson>, now = NOW, settings = DEFAULT_PLAN_SETTINGS) => planPerson({ phone: PHONE, records: [], visits: [], ...p }, settings, RULES, now);
const only = (rows: PlanRow[]) => {
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const journey = (rows: PlanRow[], j: string) => {
  const found = rows.filter((r) => r.journey === j);
  expect(found, `one ${j} row`).toHaveLength(1);
  return found[0]!;
};

describe("enquiries", () => {
  it("calls a fresh enquiry to book a consultation, with what the script needs", () => {
    const r = only(plan({ records: [lead({ treatment: "Laser Hair Removal", source: "Instagram", centre: "Kondapur" })] }));
    expect(r).toMatchObject({ journey: "new_enquiry", programKey: "clinic.warm_followup", verdict: "call_now", priority: 40, originType: "crm_record", originLabel: "Zoho Lead" });
    expect(r.callAt).toEqual(NOW);
    expect(r.reason).toBe("Enquired 2 days ago about Laser Hair Removal through Instagram.");
    expect(r.context).toEqual({ caller_name: "Anitha", enquiry_about: "Laser Hair Removal", enquiry_date: "2026-09-29", enquiry_source: "Instagram", branch: "Kondapur" });
  });

  it("puts an enquiry from the last day ahead of every other enquiry", () => {
    const r = only(plan({ records: [lead({ createdExt: ist("2026-10-01 09:00") })] }));
    expect(r.priority).toBeGreaterThan(50);
    expect(r.reason).toMatch(/^Enquired today\. Called first/);
  });

  it("reads statuses the way people type them", () => {
    expect(only(plan({ records: [lead({ status: "follow up" })] })).journey).toBe("new_enquiry");
    expect(only(plan({ records: [lead({ status: "-None-" })] })).journey).toBe("new_enquiry");
  });

  it("keeps out an enquiry older than the fresh limit", () => {
    const r = only(plan({ records: [lead({ createdExt: ist("2026-08-17 10:00") })] }));
    expect(r).toMatchObject({ journey: "new_enquiry", verdict: "kept_out", callAt: null, context: {} });
    expect(r.reason).toBe(`Enquired 45 days ago. ${COLD}`);
  });

  it("keeps out an enquiry with no date", () => {
    expect(only(plan({ records: [lead({ createdExt: null })] })).reason).toBe("Zoho has no enquiry date for this record, so JENAI cannot tell how recent it is.");
  });

  it("calls back on the day the team noted", () => {
    const r = only(plan({ records: [lead({ status: "Follow-up", followUpAt: ist("2026-10-03 00:00") })] }));
    expect(r).toMatchObject({ journey: "callback_due", verdict: "scheduled", reason: "The team noted a callback for Sat 3 Oct 2026." });
    expect(r.callAt).toEqual(ist("2026-10-03 10:00"));
  });

  it("calls back on 'call back after 3/10/26' in Description, though the enquiry is older than the fresh limit", () => {
    const followUpAt = callbackFromNotes("Spoke to her, call back after 3 /10/ 26 for the LHR price", ist("2026-09-20 10:00"));
    expect(followUpAt).toEqual(ist("2026-10-03 00:00"));
    const monday = ist("2026-10-05 11:00");
    const r = only(plan({ records: [lead({ status: "Follow-up", createdExt: ist("2026-08-01 10:00"), followUpAt })] }, monday));
    expect(r).toMatchObject({ journey: "callback_due", verdict: "call_now", reason: "The team noted a callback for Sat 3 Oct 2026, and it is due." });
    expect(r.callAt).toEqual(monday);
  });

  it("keeps out a callback noted longer ago than the fresh limit", () => {
    const r = only(plan({ records: [lead({ status: "Follow-up", createdExt: ist("2026-08-01 10:00"), followUpAt: ist("2026-08-20 00:00") })] }));
    expect(r).toMatchObject({ journey: "callback_due", verdict: "kept_out" });
    expect(r.reason).toBe(`The team noted a callback for Thu 20 Aug 2026, 42 days ago. ${COLD}`);
  });

  it("checks in 3 days after a consultation when they have not booked", () => {
    const r = only(plan({ records: [lead({ status: "Follow-up", createdExt: ist("2026-08-01 10:00"), consultant: "Dr Rao", treatment: "Acne", appointmentAt: ist("2026-09-29 15:00") })] }).filter((x) => x.verdict !== "kept_out"));
    expect(r).toMatchObject({ journey: "after_consultation", programKey: "clinic.prescription_followup", verdict: "scheduled" });
    expect(r.callAt).toEqual(ist("2026-10-02 10:00"));
    expect(r.reason).toBe('Had a consultation on Tue 29 Sep 2026 with Dr Rao and is still marked "Follow-up" in Zoho.');
    expect(r.context).toEqual({ caller_name: "Anitha", visit_date: "2026-09-29", treatment: "Acne", doctor: "Dr Rao" });
  });

  it("knows a consultation by its category too, and only within 60 days", () => {
    const byCategory = plan({ records: [lead({ status: "Interested", treatment: "Skin / Consultation", appointmentAt: ist("2026-09-20 11:00") })] });
    expect(journey(byCategory, "after_consultation").verdict).toBe("call_now");
    const old = plan({ records: [lead({ status: "Interested", consultant: "Dr Rao", appointmentAt: ist("2026-07-20 11:00") })] });
    expect(old.some((r) => r.journey === "after_consultation")).toBe(false);
  });
});

describe("appointments", () => {
  const booked = (at: string, over: Partial<PlanRecord> = {}) => lead({ status: "Appointment Booked", appointmentAt: ist(at), consultant: "Dr Rao", centre: "Kondapur", ...over });

  it("reminds them at 6 pm the evening before an appointment tomorrow morning", () => {
    const r = only(plan({ records: [booked("2026-10-02 10:30")] }));
    expect(r).toMatchObject({ journey: "appointment_reminder", programKey: "clinic.appointment_reminder", verdict: "scheduled", reason: "Appointment on Fri 2 Oct 2026 at 10:30 AM." });
    expect(r.callAt).toEqual(ist("2026-10-01 18:00"));
    expect(r.context).toEqual({ caller_name: "Anitha", appointment_date: "2026-10-02", appointment_time: "10:30 AM", doctor: "Dr Rao", branch: "Kondapur" });
  });

  it("reminds them 3 hours before an appointment later today, or now when that has passed", () => {
    expect(only(plan({ records: [booked("2026-10-01 17:00")] })).callAt).toEqual(ist("2026-10-01 14:00"));
    const soon = only(plan({ records: [booked("2026-10-01 14:30")] }));
    expect(soon).toMatchObject({ verdict: "call_now" });
    expect(soon.callAt).toEqual(NOW);
  });

  it("does not remind them under 2 hours before", () => {
    const r = only(plan({ records: [booked("2026-10-01 13:30")] }));
    expect(r).toMatchObject({ journey: "appointment_reminder", verdict: "kept_out" });
    expect(r.reason).toBe("Their appointment on Thu 1 Oct 2026 at 1:30 PM is under 2 hours away: too close for a reminder call.");
  });

  it("reminds them on Saturday evening for a Monday appointment, Sunday being no calling day", () => {
    expect(only(plan({ records: [booked("2026-10-05 16:00")] })).callAt).toEqual(ist("2026-10-03 18:00"));
  });

  it("on a Sunday, reminds them on Monday morning, or keeps out a Monday appointment too early for that", () => {
    const sunday = ist("2026-10-04 12:00");
    const r = only(plan({ records: [booked("2026-10-05 12:30")] }, sunday));
    expect(r).toMatchObject({ verdict: "scheduled" });
    expect(r.callAt).toEqual(ist("2026-10-05 10:00"));
    const early = only(plan({ records: [booked("2026-10-05 11:00")] }, sunday));
    expect(early).toMatchObject({ verdict: "kept_out", reason: "No calling hours are left far enough before their appointment on Mon 5 Oct 2026 at 11:00 AM for a reminder call." });
  });

  it("after calling hours the evening before, reminds them the next morning", () => {
    const r = only(plan({ records: [booked("2026-10-02 15:00")] }, ist("2026-10-01 20:00")));
    expect(r.verdict).toBe("call_now");
    expect(r.callAt).toEqual(ist("2026-10-02 10:00"));
  });

  it("keeps out an appointment that has passed while the CRM still says booked", () => {
    const r = only(plan({ records: [booked("2026-09-30 11:00")] }));
    expect(r).toMatchObject({ journey: "appointment_unclear", verdict: "kept_out", programKey: "" });
    expect(r.reason).toBe("Their appointment date has passed and Zoho still says booked, so JENAI cannot tell if they came. Update the status in Zoho.");
  });

  it("lets the visit list answer a booking whose date has passed", () => {
    const rows = plan({ records: [booked("2026-09-30 11:00")], visits: [visit()] });
    expect(rows.some((r) => r.originType === "crm_record")).toBe(false);
    expect(journey(rows, "visit_feedback").verdict).toBe("scheduled");
  });

  it("keeps out a booking with no appointment date", () => {
    expect(only(plan({ records: [lead({ status: "Appointment Booked" })] })).reason).toBe(
      "Zoho says booked but has no appointment date, so JENAI cannot remind them. Add the date in Zoho.",
    );
  });

  it("reminds an existing client of an appointment coming up", () => {
    expect(only(plan({ records: [booked("2026-10-02 10:30", { status: "Existing Client" })] })).journey).toBe("appointment_reminder");
  });
});

describe("missed appointments", () => {
  it("calls to rebook a recent no-show", () => {
    const r = only(plan({ records: [lead({ status: "No Show", appointmentAt: ist("2026-09-26 11:00") })] }));
    expect(r).toMatchObject({ journey: "no_show_rebook", programKey: "clinic.warm_followup", verdict: "call_now", reason: "Missed their appointment on Sat 26 Sep 2026." });
  });

  it("keeps out a no-show older than the fresh limit", () => {
    const r = only(plan({ records: [lead({ status: "No Show", appointmentAt: ist("2026-08-22 11:00") })] }));
    expect(r).toMatchObject({ journey: "no_show_rebook", verdict: "kept_out", reason: `Missed their appointment 40 days ago. ${COLD}` });
  });

  it("goes by the enquiry date when there is no appointment date", () => {
    expect(only(plan({ records: [lead({ status: "No Show" })] })).verdict).toBe("call_now");
  });
});

describe("after a visit", () => {
  it("asks how the visit went 2 days after it, the other calls waiting their turn", () => {
    const rows = plan({ visits: [visit({ doctor: "Dr Rao", branch: "Kondapur" })] });
    const fb = journey(rows, "visit_feedback");
    expect(fb).toMatchObject({ programKey: "clinic.feedback", verdict: "scheduled", originType: "visit", originLabel: "Visit list", reason: "Visited on Wed 30 Sep 2026 for Hydrafacial." });
    expect(fb.callAt).toEqual(ist("2026-10-02 10:00"));
    expect(fb.context).toEqual({ caller_name: "Anitha", visit_date: "2026-09-30", doctor: "Dr Rao", branch: "Kondapur" });
    for (const j of ["result_check", "maintenance"]) {
      expect(journey(rows, j)).toMatchObject({ verdict: "waiting", reason: "Another call to this person comes first: Ask how their visit went" });
    }
  });

  it("asks for feedback once for a day with several services", () => {
    const rows = plan({ visits: [visit(), visit({ service: "Glycolic Peel" })] });
    expect(rows.filter((r) => r.journey === "visit_feedback")).toHaveLength(1);
  });

  it("checks on results once they should show, marking the default timing", () => {
    const rows = plan({ visits: [visit({ service: "HIFU Face", visitDate: "2026-08-27", doctor: "Dr Rao" })] });
    expect(rows.some((r) => r.journey === "visit_feedback")).toBe(false);
    const rc = journey(rows, "result_check");
    expect(rc).toMatchObject({ programKey: "clinic.prescription_followup", verdict: "call_now" });
    expect(rc.reason).toBe("Had HIFU Face on Thu 27 Aug 2026; results usually show by about 30 days. Timing is JENAI's default until the clinic's doctors confirm it.");
    expect(rc.context).toEqual({ caller_name: "Anitha", visit_date: "2026-08-27", treatment: "HIFU Face", doctor: "Dr Rao", review_due: "2026-09-26" });
    expect(journey(rows, "maintenance").verdict).toBe("waiting");
  });

  it("drops a result check more than 30 days past due", () => {
    const rows = plan({ visits: [visit({ service: "HIFU", visitDate: "2026-07-01" })] });
    expect(rows.map((r) => r.journey)).toEqual(["maintenance"]);
    expect(rows[0]!.callAt).toEqual(ist("2027-07-01 10:00"));
  });

  it("books the next session of a course that is not finished", () => {
    const rows = plan({ visits: [visit({ service: "Glycolic Peel", visitDate: "2026-08-01" }), visit({ service: "glycolic  peel", visitDate: "2026-08-22" })] });
    const r = only(rows);
    expect(r).toMatchObject({ journey: "next_session", programKey: "clinic.revisit_recall", verdict: "call_now" });
    expect(r.reason).toMatch(/^Session 3 of 4 of glycolic {2}peel is due 21 days after the last, on Sat 22 Aug 2026\./);
    expect(r.context).toEqual({ caller_name: "Anitha", treatment: "glycolic  peel", last_visit: "2026-08-22" });
  });

  it("books maintenance once the course is done, going by the clinic's session count", () => {
    const r = only(plan({ visits: [visit({ service: "Laser Hair Removal - Full Legs", visitDate: "2026-06-01", sessionsDone: 6, sessionsTotal: 6 })] }));
    expect(r).toMatchObject({ journey: "maintenance", verdict: "scheduled" });
    expect(r.callAt).toEqual(ist("2026-11-28 10:00"));
    expect(r.reason).toMatch(/^Finished the course of Laser Hair Removal - Full Legs on Mon 1 Jun 2026; maintenance is due every 180 days\./);
  });

  it("uses the clinic's own rule over a default, and the longest word that matches", () => {
    expect(ruleFor("Laser Hair Removal", RULES).label).toBe("Laser hair removal");
    expect(ruleFor("GFC Hair", RULES).label).toBe("PRP, GFC or hair treatment");
    expect(ruleFor("Ear piercing", RULES).match).toEqual([]);
    const own = treatmentRulesFor(
      [{ tenantId: "t", id: "r", match: "Hydrafacial", label: "Hydrafacial", feedbackAfterDays: null, resultCheckAfterDays: null, sessionIntervalDays: null, courseSessions: null, maintenanceAfterDays: 45, updatedAt: NOW }],
      "dermatology",
    );
    const rows = planPerson({ phone: PHONE, records: [], visits: [visit({ visitDate: "2026-08-01" })] }, DEFAULT_PLAN_SETTINGS, own, NOW);
    const r = only(rows);
    expect(r).toMatchObject({ journey: "maintenance", reason: "Had Hydrafacial on Sat 1 Aug 2026; maintenance is due every 45 days." });
  });

  it("takes the visit from a customer's appointment date when there is no visit list", () => {
    const rows = plan({ records: [lead({ id: "lead-c", status: "Converted", treatment: "Hydrafacial", appointmentAt: ist("2026-09-30 15:00") })] });
    expect(journey(rows, "visit_feedback")).toMatchObject({ originType: "crm_record", originId: "lead-c", originLabel: "Zoho Lead", verdict: "scheduled" });
  });

  it("keeps out a customer with no visit date, and says to upload the visit list", () => {
    const r = only(plan({ records: [lead({ status: "Existing Client" })] }));
    expect(r).toMatchObject({ journey: "no_call", verdict: "kept_out", reason: "Zoho has no visit date for this patient. Upload the visit list so JENAI knows what they had and when." });
    expect(plan({ records: [lead({ status: "Existing Client" })], visits: [visit()] }).every((x) => x.originType === "visit")).toBe(true);
  });

  it("still shows a patient none of whose calls is due any more", () => {
    const r = only(plan({ visits: [visit({ service: "Acne", visitDate: "2025-01-10" })] }));
    expect(r).toMatchObject({ journey: "no_call", verdict: "kept_out", reason: "Last visit on Fri 10 Jan 2025 for Acne: no call about it is due any more." });
  });
});

describe("kept out", () => {
  it.each(["Junk Lead", "Not Interested", "Invalid", "Do Not Call"])("keeps out %s, with the status as the reason", (status) => {
    const r = only(plan({ records: [lead({ status })] }));
    expect(r).toMatchObject({ journey: "no_call", verdict: "kept_out", reason: `Marked "${status}" in Zoho.` });
  });

  it("keeps out a status the settings do not know, and says where to add it", () => {
    expect(only(plan({ records: [lead({ status: "Hot" })] })).reason).toMatch(/^"Hot" is not a status the plan settings know/);
  });

  it("keeps out someone only in Zoho Contacts", () => {
    const contact = { id: "c-1", module: "Contacts", crm: "Zoho", phoneE164: PHONE, name: "Anitha" };
    expect(only(plan({ records: [contact] })).reason).toBe("Only in Zoho Contacts: no enquiry or visit on record.");
    // With an enquiry on record, the contact adds nothing of its own.
    expect(only(plan({ records: [contact, lead()] })).originId).not.toBe("c-1");
  });

  it("keeps out a record with no number JENAI can dial", () => {
    const r = only(plan({ phone: null, records: [lead({ phoneE164: null })] }));
    expect(r).toMatchObject({ journey: "new_enquiry", verdict: "kept_out", reason: "No phone number JENAI can dial.", phoneE164: null });
  });

  it("keeps out a centre the plan does not cover, naming it", () => {
    const settings = planSettingsOf({ centres: ["Kondapur"] });
    expect(only(plan({ records: [lead({ centre: "Jubilee Hills" })] }, NOW, settings)).reason).toBe("For the Jubilee Hills centre, which this plan does not cover.");
    expect(only(plan({ records: [lead({ centre: "KONDAPUR" })] }, NOW, settings)).verdict).toBe("call_now");
    expect(only(plan({ records: [lead({ centre: null })] }, NOW, settings)).verdict).toBe("call_now");
  });

  it("keeps out everyone on a do-not-call list, whatever else is due", () => {
    const person: Partial<PlanPerson> = {
      records: [lead({ status: "Appointment Booked", appointmentAt: ist("2026-10-02 11:00") }), lead()],
      visits: [visit()],
      suppressions: [{ reason: "dnd_registry" }, { reason: "opt_out", expiresAt: null }],
    };
    const rows = plan(person);
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(r).toMatchObject({ verdict: "kept_out", reason: "Asked not to be called.", callAt: null, context: {} });
    expect(plan({ ...person, suppressions: [{ reason: "dnd_registry" }] })[0]!.reason).toBe("On the national Do Not Disturb register.");
    expect(plan({ ...person, suppressions: [{ reason: "opt_out", expiresAt: ist("2026-09-30 00:00") }] }).some((r) => r.verdict !== "kept_out")).toBe(true);
  });

  it("keeps out the whole person when any record says Do Not Call", () => {
    const rows = plan({ records: [lead(), lead({ status: "do not call" })], visits: [visit()] });
    for (const r of rows) expect(r).toMatchObject({ verdict: "kept_out", reason: 'Marked "do not call" in Zoho.' });
  });
});

describe("one call per person", () => {
  it("makes the highest-priority call that is due and holds the rest", () => {
    const rows = plan({ records: [lead({ status: "Follow-up", followUpAt: ist("2026-09-30 00:00") }), lead()] });
    expect(journey(rows, "callback_due").verdict).toBe("call_now");
    expect(journey(rows, "new_enquiry")).toMatchObject({ verdict: "waiting", reason: "Another call to this person comes first: Call back on the date the team noted" });
  });

  it("does not call to book someone whose appointment is coming up", () => {
    const rows = plan({ records: [lead({ status: "Appointment Booked", appointmentAt: ist("2026-10-02 11:00") }), lead()] });
    expect(journey(rows, "appointment_reminder").verdict).toBe("scheduled");
    expect(journey(rows, "new_enquiry")).toMatchObject({ verdict: "waiting", reason: "Another call to this person comes first: Remind them of their appointment" });
  });

  it("keeps calls apart from their last call, but not a reminder", () => {
    const lastCallAt = ist("2026-09-30 11:00");
    const r = only(plan({ records: [lead()], lastCallAt }));
    expect(r.verdict).toBe("scheduled");
    expect(r.callAt).toEqual(ist("2026-10-03 11:00"));
    expect(r.reason).toBe("Enquired 2 days ago. Moved to Sat 3 Oct 2026: the last call with them was on Wed 30 Sep 2026, and calls are kept 3 days apart.");
    const reminder = only(plan({ records: [lead({ status: "Appointment Booked", appointmentAt: ist("2026-10-02 11:00") })], lastCallAt }));
    expect(reminder.callAt).toEqual(ist("2026-10-01 18:00"));
  });

  it("moves a call into calling hours: tonight to tomorrow morning, Saturday night to Monday", () => {
    const tonight = only(plan({ records: [lead()] }, ist("2026-10-01 20:00")));
    expect(tonight.verdict).toBe("call_now");
    expect(tonight.callAt).toEqual(ist("2026-10-02 10:00"));
    expect(only(plan({ records: [lead()] }, ist("2026-10-03 20:00"))).callAt).toEqual(ist("2026-10-05 10:00"));
    // Feedback due on Sunday 4 Oct waits for Monday.
    const fb = journey(plan({ visits: [visit({ visitDate: "2026-10-02" })] }, ist("2026-10-02 18:00")), "visit_feedback");
    expect(fb.callAt).toEqual(ist("2026-10-05 10:00"));
  });

  it("says when the workspace has no call script for the program yet, keeping the verdict", () => {
    const r = only(plan({ records: [lead()], programs: new Set(["clinic.feedback"]) }));
    expect(r.verdict).toBe("call_now");
    expect(r.reason).toBe("Enquired 2 days ago." + NOT_SET_UP);
    expect(only(plan({ records: [lead()], programs: new Set(["clinic.warm_followup"]) })).reason).toBe("Enquired 2 days ago.");
  });
});

describe("plan settings", () => {
  it("keeps the default for anything missing or unusable", () => {
    const s = planSettingsOf({ freshDays: 45, minGapDays: -1, reminderHour: "6pm", openStatuses: ["Warm", 3], callingWindow: { days: [1], start: "21:00", end: "23:00" } }, "Asia/Kolkata");
    expect(s.freshDays).toBe(45);
    expect(s.minGapDays).toBe(3);
    expect(s.reminderHour).toBe(18);
    expect(s.openStatuses).toEqual(["Warm"]);
    expect(s.callingWindow).toEqual(DEFAULT_PLAN_SETTINGS.callingWindow);
    expect(planSettingsOf(null)).toEqual(DEFAULT_PLAN_SETTINGS);
  });
});

// ---------------------------------------------------------------- replanTenant, against the database

describe("replanning a client", () => {
  let org = "";
  let other = "";
  let integrationId = "";
  const ids: Record<string, string> = {};
  const phone = (k: number) => `+91990000${String(k).padStart(4, "0")}`;

  beforeAll(async () => {
    const made = await platformDb()
      .insert(organizations)
      .values(["A", "B"].map((x) => ({ kind: "client" as const, name: `Replan Clinic ${x}`, slug: `replan-${x.toLowerCase()}-${randomUUID().slice(0, 8)}`, status: "active" as const, vertical: "dermatology", languages: ["en"] })))
      .returning({ id: organizations.id });
    [org, other] = [made[0]!.id, made[1]!.id];
    await withTenant(org, async (tx) => {
      const [i] = await tx.insert(integrations).values({ tenantId: org, kind: "zoho_crm", name: "Zoho" }).returning();
      integrationId = i!.id;
      const rec = (externalId: string, p: string | null, v: Partial<typeof crmRecords.$inferInsert>) => ({ tenantId: org, integrationId, module: "Leads", externalId, phoneE164: p, name: "Patient", createdExt: ist("2026-09-29 11:00"), ...v });
      const rows = await tx
        .insert(crmRecords)
        .values([
          rec("1", phone(1), { status: "New Lead", treatment: "LHR" }),
          rec("2", phone(2), { status: "Junk Lead" }),
          rec("3", phone(3), { status: "Appointment Booked", appointmentAt: ist("2026-10-02 11:00") }),
          { ...rec("4", phone(4), {}), module: "Contacts", createdExt: null },
          rec("5", phone(5), { status: "New Lead" }),
          rec("6", null, { status: "New Lead" }),
        ])
        .returning({ id: crmRecords.id, externalId: crmRecords.externalId });
      for (const r of rows) ids[r.externalId] = r.id;
      await tx.insert(visits).values({ tenantId: org, phoneE164: phone(7), name: "Patient", service: "Hydrafacial", visitDate: "2026-09-30" });
      await tx.insert(suppressions).values({ tenantId: org, phoneE164: phone(5), reason: "opt_out", scope: null, source: "test" });
      await tx.insert(calls).values({ tenantId: org, direction: "outbound", externalRunId: `run-${randomUUID()}`, toE164: phone(1), startedAt: ist("2026-09-30 11:00"), status: "completed" });
      await tx.insert(clientPrograms).values({ tenantId: org, programKey: "clinic.feedback", programVersion: 1, name: "Feedback" });
    });
    // Another client's plan, which replanning this one must leave alone.
    await withTenant(other, (tx) =>
      tx.insert(plannedCalls).values({ tenantId: other, journey: "new_enquiry", programKey: "clinic.warm_followup", verdict: "call_now", reason: "x", originType: "visit", originId: randomUUID(), originLabel: "Visit list" }),
    );
  });

  afterAll(async () => {
    await platformDb().delete(organizations).where(inArray(organizations.id, [org, other]));
  });

  const stored = () =>
    withTenant(org, async (tx) =>
      (await tx.select().from(plannedCalls)).map(({ computedAt: _, ...r }) => r).sort((a, b) => `${a.originId}${a.journey}`.localeCompare(`${b.originId}${b.journey}`)),
    );

  it("plans everyone, stores it, and gives the same rows when run again", async () => {
    const first = await replanTenant(org, { now: NOW });
    expect(first).toMatchObject({ people: 7, removed: 0, waitingForPhone: 0 });
    expect(first.byJourney.new_enquiry).toEqual({ scheduled: 1, kept_out: 2 });
    expect(first.byJourney.appointment_reminder).toEqual({ scheduled: 1 });
    expect(first.byJourney.no_call).toEqual({ kept_out: 2 });
    expect(first.byJourney.visit_feedback).toEqual({ scheduled: 1 });

    const rows = await stored();
    expect(rows).toHaveLength(first.rows);
    const of = (ext: string, j: string) => rows.find((r) => r.originId === ids[ext] && r.journey === j)!;
    // Moved off their call yesterday; no warm follow-up script set up here yet.
    expect(of("1", "new_enquiry")).toMatchObject({ verdict: "scheduled", phoneE164: phone(1), originLabel: "Zoho Lead", context: { caller_name: "Patient", enquiry_about: "LHR", enquiry_date: "2026-09-29" } });
    expect(of("1", "new_enquiry").reason).toMatch(/calls are kept 3 days apart\. \(call script not added to this workspace yet\)$/);
    expect(of("1", "new_enquiry").callAt).toEqual(ist("2026-10-03 11:00"));
    expect(of("2", "no_call").reason).toBe('Marked "Junk Lead" in Zoho.');
    expect(of("4", "no_call").reason).toBe("Only in Zoho Contacts: no enquiry or visit on record.");
    expect(of("5", "new_enquiry")).toMatchObject({ verdict: "kept_out", reason: "Asked not to be called." });
    expect(of("6", "new_enquiry")).toMatchObject({ verdict: "kept_out", reason: "No phone number JENAI can dial.", phoneE164: null });
    expect(rows.find((r) => r.journey === "visit_feedback")).toMatchObject({ verdict: "scheduled", reason: "Visited on Wed 30 Sep 2026 for Hydrafacial." });

    const again = await replanTenant(org, { now: NOW });
    expect(again).toEqual(first);
    expect(await stored()).toEqual(rows);
  });

  it("removes rows that no longer apply", async () => {
    await withTenant(org, async (tx) => {
      await tx.update(crmRecords).set({ deletedAt: NOW }).where(eq(crmRecords.id, ids["1"]!));
      await tx.update(crmRecords).set({ status: "No Show" }).where(eq(crmRecords.id, ids["3"]!));
    });
    const r = await replanTenant(org, { now: NOW });
    expect(r.removed).toBe(2);
    const rows = await stored();
    expect(rows.some((x) => x.originId === ids["1"])).toBe(false);
    expect(rows.filter((x) => x.originId === ids["3"]).map((x) => x.journey)).toEqual(["no_show_rebook"]);
  });

  it("never dials, queues a campaign or hands anything to the CRM, and leaves other clients alone", async () => {
    await withTenant(org, async (tx) => {
      expect(await tx.select().from(campaignTargets)).toHaveLength(0);
      expect(await tx.select().from(integrationEvents)).toHaveLength(0);
      expect(await tx.select().from(calls)).toHaveLength(1);
    });
    expect(await withTenant(other, (tx) => tx.select().from(plannedCalls))).toHaveLength(1);
  });

  it("counts a visit still waiting for its phone number, and plans it once the number arrives", async () => {
    const [v] = await withTenant(org, async (tx) => {
      const [desk] = await tx.insert(integrations).values({ tenantId: org, kind: "zenoti", name: "Zenoti", direction: "in" }).returning();
      return tx.insert(visits).values({ tenantId: org, integrationId: desk!.id, externalId: "line-1", guestRef: "guest-1", service: "Hydrafacial", visitDate: "2026-09-30", source: "api" }).returning();
    });
    const before = await replanTenant(org, { now: NOW });
    expect(before.waitingForPhone).toBe(1);
    expect((await stored()).some((r) => r.originId === v!.id)).toBe(false);

    await withTenant(org, (tx) => tx.update(visits).set({ phoneE164: phone(8) }).where(eq(visits.id, v!.id)));
    const after = await replanTenant(org, { now: NOW });
    expect(after).toMatchObject({ waitingForPhone: 0, people: before.people + 1 });
    expect((await stored()).find((r) => r.originId === v!.id && r.journey === "visit_feedback")).toMatchObject({ verdict: "scheduled", phoneE164: phone(8) });
  });
});
