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
  branches,
  callPlanSettings,
  campaignTargets,
  calls,
  clientPrograms,
  clinicAppointments,
  crmRecords,
  externalPeople,
  integrationEvents,
  integrations,
  organizations,
  packageBalances,
  plannedCalls,
  platformDb,
  suppressions,
  visits,
  withTenant,
  type ClinicAppointmentStatus,
} from "@jenai/db";
import {
  DEFAULT_PLAN_SETTINGS,
  PLAN_JOURNEYS,
  planPerson,
  planSettingsOf,
  replanTenant,
  ruleFor,
  treatmentRulesFor,
  type PlanBooking,
  type PlanPackage,
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
/** A booking in Zenoti, the clinic's front desk system. */
const booking = (over: Partial<PlanBooking> = {}): PlanBooking => ({
  id: `booking-${++n}`,
  system: "Zenoti",
  name: "Anitha",
  service: "LHR Full Legs",
  startsAt: ist("2026-10-02 10:30"),
  status: "booked",
  doctor: "Dr. Asha",
  centre: "Kondapur",
  ...over,
});
/** Their laser package in Zenoti: 3 of 5 sessions used. */
const pack = (over: Partial<PlanPackage> = {}): PlanPackage => ({ system: "Zenoti", service: "LHR Full Legs", total: 5, used: 3, balance: 2, status: "active", expiresOn: "2027-03-01", ...over });
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

describe("bookings at the front desk", () => {
  const live = (rows: PlanRow[]) => rows.filter((r) => r.verdict !== "kept_out");

  it("reminds them of a booking in Zenoti, the evening before, with what the script needs", () => {
    const r = only(plan({ bookings: [booking()] }));
    expect(r).toMatchObject({ journey: "appointment_reminder", programKey: "clinic.appointment_reminder", verdict: "scheduled", originType: "clinic_appointment", originLabel: "Zenoti booking" });
    expect(r.callAt).toEqual(ist("2026-10-01 18:00"));
    expect(r.reason).toBe("Appointment on Fri 2 Oct 2026 at 10:30 AM for LHR Full Legs, booked in Zenoti.");
    expect(r.context).toEqual({ caller_name: "Anitha", appointment_date: "2026-10-02", appointment_time: "10:30 AM", doctor: "Dr. Asha", branch: "Kondapur" });
    expect(only(plan({ bookings: [booking({ status: "confirmed" })] })).journey).toBe("appointment_reminder");
  });

  it("makes one reminder for several services booked the same day", () => {
    const r = only(plan({ bookings: [booking({ service: "Hydrafacial", startsAt: ist("2026-10-02 11:30") }), booking()] }));
    expect(r.reason).toBe("Appointment on Fri 2 Oct 2026 at 10:30 AM for LHR Full Legs and Hydrafacial, booked in Zenoti.");
  });

  it("reminds nobody of a booking checked in or in a state JENAI does not know, and still shows them", () => {
    const r = only(plan({ bookings: [booking({ status: "unknown" })] }));
    expect(r).toMatchObject({ journey: "no_call", verdict: "kept_out", reason: "Their latest booking in Zenoti, on Fri 2 Oct 2026 at 10:30 AM, is in a state JENAI does not know: no call about it is due." });
    expect(only(plan({ bookings: [booking({ status: "checked_in" })] })).journey).toBe("no_call");
    const stale = only(plan({ bookings: [booking({ startsAt: ist("2026-09-28 11:00") })] }));
    expect(stale).toMatchObject({ journey: "appointment_unclear", verdict: "kept_out" });
    expect(stale.reason).toBe("Their appointment on Mon 28 Sep 2026 at 11:00 AM has passed and Zenoti still says booked, so JENAI cannot tell if they came. Update it in Zenoti.");
  });

  it("plans one reminder when Zoho and Zenoti both have them booked, going by Zenoti", () => {
    for (const status of ["Appointment Booked", "Existing Client"]) {
      for (const at of ["2026-10-02 10:30", "2026-10-03 16:00"]) {
        const rows = plan({ records: [lead({ status, appointmentAt: ist(at) })], bookings: [booking()] });
        expect(only(live(rows))).toMatchObject({ journey: "appointment_reminder", originType: "clinic_appointment", verdict: "scheduled" });
        expect(rows.find((r) => r.originType === "crm_record")).toMatchObject({
          journey: "appointment_reminder",
          verdict: "kept_out",
          reason: "Booked in Zenoti for Fri 2 Oct 2026 at 10:30 AM: the reminder goes by Zenoti, the clinic's own system.",
        });
      }
    }
  });

  it("reminds nobody of a Zoho booking for a day Zenoti says was cancelled, and calls to rebook instead", () => {
    const rows = plan({ records: [lead({ status: "Appointment Booked", appointmentAt: ist("2026-10-02 11:00") })], bookings: [booking({ status: "cancelled", startsAt: ist("2026-10-02 11:00") })] });
    expect(rows.find((r) => r.originType === "crm_record")).toMatchObject({
      journey: "appointment_reminder",
      verdict: "kept_out",
      reason: "Cancelled in Zenoti for Fri 2 Oct 2026 at 11:00 AM: no reminder, as Zenoti is the clinic's own system.",
    });
    expect(only(live(rows))).toMatchObject({ journey: "cancelled_rebook", verdict: "call_now", reason: "Cancelled their appointment for LHR Full Legs booked for Fri 2 Oct 2026." });
  });

  it("does not show the Zoho Contacts note for someone booked in Zenoti", () => {
    const contact = { id: "c-2", module: "Contacts", crm: "Zoho", phoneE164: PHONE, name: "Anitha" };
    expect(plan({ records: [contact], bookings: [booking()] }).some((r) => r.originId === "c-2")).toBe(false);
  });

  it("keeps a booking at a centre the plan does not cover out, naming it", () => {
    const settings = planSettingsOf({ centres: ["Kondapur"] });
    expect(only(plan({ bookings: [booking({ centre: "Jubilee Hills" })] }, NOW, settings))).toMatchObject({ verdict: "kept_out", reason: "For the Jubilee Hills centre, which this plan does not cover." });
  });
});

describe("missed and cancelled bookings at the front desk", () => {
  const noShow = (over: Partial<PlanBooking> = {}) => booking({ status: "no_show", service: "PRP - Hair", startsAt: ist("2026-09-20 16:30"), ...over });
  const cancelled = (over: Partial<PlanBooking> = {}) => booking({ status: "cancelled", service: "Consultation", startsAt: ist("2026-09-28 11:00"), ...over });

  it("calls to rebook a recent no-show in Zenoti", () => {
    const r = only(plan({ bookings: [noShow()] }));
    expect(r).toMatchObject({ journey: "no_show_rebook", programKey: "clinic.warm_followup", verdict: "call_now", originType: "clinic_appointment", reason: "Missed their appointment on Sun 20 Sep 2026 for PRP - Hair." });
    expect(r.callAt).toEqual(NOW);
    expect(r.context).toEqual({ caller_name: "Anitha", enquiry_about: "PRP - Hair", branch: "Kondapur" });
  });

  it("does not call a no-show who has booked again or come in since", () => {
    const rows = plan({ bookings: [noShow(), booking()] });
    expect(journey(rows, "no_show_rebook")).toMatchObject({ verdict: "kept_out", reason: "Missed their appointment on Sun 20 Sep 2026 for PRP - Hair, but is booked again for Fri 2 Oct 2026." });
    expect(journey(rows, "appointment_reminder").verdict).toBe("scheduled");
    const came = plan({ bookings: [noShow()], visits: [visit({ visitDate: "2026-09-25" })] });
    expect(journey(came, "no_show_rebook")).toMatchObject({ verdict: "kept_out", reason: "Missed their appointment on Sun 20 Sep 2026 for PRP - Hair, but came in on Fri 25 Sep 2026." });
    // Long past and followed by a visit, it is history: no row at all.
    expect(plan({ bookings: [noShow({ startsAt: ist("2026-08-01 11:00") })], visits: [visit({ visitDate: "2026-08-10" })] }).some((r) => r.journey === "no_show_rebook")).toBe(false);
  });

  it("keeps out a no-show older than the fresh limit", () => {
    expect(only(plan({ bookings: [noShow({ startsAt: ist("2026-08-22 11:00") })] }))).toMatchObject({ journey: "no_show_rebook", verdict: "kept_out", reason: `Missed their appointment 40 days ago. ${COLD}` });
  });

  it("calls to rebook a recent cancellation, below a no-show", () => {
    const r = only(plan({ bookings: [cancelled()] }));
    expect(r).toMatchObject({ journey: "cancelled_rebook", programKey: "clinic.warm_followup", verdict: "call_now", priority: 25, reason: "Cancelled their appointment for Consultation booked for Mon 28 Sep 2026." });
    expect(PLAN_JOURNEYS.cancelled_rebook).toEqual({ program: "clinic.warm_followup", label: "They cancelled: call to rebook", priority: 25 });
    const order = Object.keys(PLAN_JOURNEYS);
    expect(order.indexOf("cancelled_rebook")).toBe(order.indexOf("no_show_rebook") + 1);
    expect(PLAN_JOURNEYS.cancelled_rebook.priority).toBeLessThan(PLAN_JOURNEYS.no_show_rebook.priority);
    // A no-show in Zoho and a cancellation in Zenoti, both due now: the no-show call first.
    const both = plan({ records: [lead({ status: "No Show", appointmentAt: ist("2026-09-26 11:00") })], bookings: [cancelled()] });
    expect(journey(both, "no_show_rebook").verdict).toBe("call_now");
    expect(journey(both, "cancelled_rebook")).toMatchObject({ verdict: "waiting", reason: "Another call to this person comes first: They missed their appointment: call to rebook" });
  });

  it("does not call to rebook a cancellation moved to another day, and keeps out an old one", () => {
    const moved = plan({ bookings: [cancelled({ startsAt: ist("2026-10-10 11:00") }), booking({ service: "Consultation", startsAt: ist("2026-10-06 10:00") })] });
    expect(journey(moved, "cancelled_rebook")).toMatchObject({ verdict: "kept_out", reason: "Cancelled their appointment for Consultation booked for Sat 10 Oct 2026, but is booked again for Tue 6 Oct 2026." });
    expect(journey(moved, "appointment_reminder")).toMatchObject({ verdict: "scheduled" });
    expect(only(plan({ bookings: [cancelled({ startsAt: ist("2026-08-22 11:00") })] }))).toMatchObject({ verdict: "kept_out", reason: `Their cancelled appointment was 40 days ago. ${COLD}` });
  });

  it("calls about their latest missed booking only, a no-show before a cancellation the same day", () => {
    expect(only(plan({ bookings: [noShow(), cancelled()] })).journey).toBe("cancelled_rebook");
    expect(only(plan({ bookings: [cancelled({ startsAt: ist("2026-09-28 10:00") }), noShow({ startsAt: ist("2026-09-28 12:00") })] })).journey).toBe("no_show_rebook");
  });

  it("does not call a Zoho no-show who has come in since, as Zenoti shows", () => {
    const r = only(plan({ records: [lead({ status: "No Show", appointmentAt: ist("2026-09-20 11:00") })], bookings: [booking({ status: "completed", startsAt: ist("2026-09-24 11:00") })] }));
    expect(r).toMatchObject({ journey: "no_show_rebook", verdict: "kept_out", reason: "Missed their appointment on Sun 20 Sep 2026, but came in on Thu 24 Sep 2026." });
  });
});

describe("a Zoho booking whose date has passed, answered by Zenoti", () => {
  const passed = () => lead({ status: "Appointment Booked", appointmentAt: ist("2026-09-28 11:00") });

  it("drops 'outcome unknown' when Zenoti shows a visit on or after the day", () => {
    const rows = plan({ records: [passed()], visits: [visit({ visitDate: "2026-09-30", source: "api" })] });
    expect(rows.some((r) => r.originType === "crm_record")).toBe(false);
    const done = plan({ records: [passed()], bookings: [booking({ status: "completed", startsAt: ist("2026-09-29 11:00") })] });
    expect(done.some((r) => r.originType === "crm_record")).toBe(false);
  });

  it("drops it for a no-show in Zenoti, which is called to rebook instead", () => {
    const rows = plan({ records: [passed()], bookings: [booking({ status: "no_show", startsAt: ist("2026-09-28 11:00") })] });
    expect(only(rows)).toMatchObject({ originType: "clinic_appointment", journey: "no_show_rebook", verdict: "call_now" });
  });

  it("keeps it when what Zenoti shows came before the day", () => {
    const rows = plan({ records: [passed()], visits: [visit({ visitDate: "2026-09-20", source: "api" })], bookings: [booking({ status: "no_show", startsAt: ist("2026-09-21 11:00") })] });
    expect(journey(rows, "appointment_unclear").originType).toBe("crm_record");
  });
});

describe("packages at the front desk", () => {
  const laser = (visitDate: string) => visit({ service: "LHR Full Legs", visitDate });
  const DEFAULT_NOTE = " Timing is JENAI's default until the clinic's doctors confirm it.";

  it("books the next session from the sessions left on their package", () => {
    const r = only(plan({ visits: [laser("2026-08-01")], packages: [pack()] }));
    expect(r).toMatchObject({ journey: "next_session", verdict: "call_now", programKey: "clinic.revisit_recall" });
    expect(r.reason).toBe(`Session 4 of 5 of LHR Full Legs is due 35 days after the last, on Sat 1 Aug 2026. 2 sessions left on their package, which ends on Mon 1 Mar 2027.${DEFAULT_NOTE}`);
    // Without the package, the default course and their visits count.
    expect(only(plan({ visits: [laser("2026-08-01")] })).reason).toMatch(/^Session 2 of 6 of LHR Full Legs/);
    // Matched however the service is spelled.
    expect(only(plan({ visits: [laser("2026-08-01")], packages: [pack({ service: "lhr  FULL legs" })] })).reason).toMatch(/^Session 4 of 5/);
  });

  it("calls now when the package ends within 30 days, and says so", () => {
    const rows = plan({ visits: [laser("2026-09-30")], packages: [pack({ expiresOn: "2026-10-12" })] });
    const r = journey(rows, "next_session");
    expect(r).toMatchObject({ verdict: "call_now", reason: "2 sessions left, package ends on Mon 12 Oct 2026: called now so they can book before it does. Session 4 of 5 of LHR Full Legs is next; the last was on Wed 30 Sep 2026." });
    expect(r.callAt).toEqual(NOW);
    expect(journey(rows, "visit_feedback").verdict).toBe("waiting");
    // A clinic that wants less notice: the usual gap.
    const later = journey(plan({ visits: [laser("2026-09-30")], packages: [pack({ expiresOn: "2026-10-12" })] }, NOW, planSettingsOf({ packageEndingWithinDays: 7 })), "next_session");
    expect(later.callAt).toEqual(ist("2026-11-04 10:00"));
  });

  it("books maintenance once the package is used up", () => {
    const r = only(plan({ visits: [laser("2026-06-01")], packages: [pack({ used: 5, balance: 0 })] }));
    expect(r).toMatchObject({ journey: "maintenance", verdict: "scheduled" });
    expect(r.callAt).toEqual(ist("2026-11-28 10:00"));
    expect(r.reason).toMatch(/^Finished the course of LHR Full Legs on Mon 1 Jun 2026; maintenance is due every 180 days\./);
  });

  it("never calls about the next session of an expired or cancelled package", () => {
    const next = (p: PlanPackage) => {
      const rows = plan({ visits: [laser("2026-09-10")], packages: [p] });
      expect(rows.some((r) => r.journey === "maintenance")).toBe(false);
      return journey(rows, "next_session");
    };
    expect(next(pack({ status: "expired", expiresOn: "2026-09-15" }))).toMatchObject({
      verdict: "kept_out",
      reason: "Their package for LHR Full Legs ended on Tue 15 Sep 2026 with 2 sessions unused, so there is no next session to call about.",
    });
    // Past its end date, whatever status was last read.
    expect(next(pack({ expiresOn: "2026-09-20" })).reason).toBe("Their package for LHR Full Legs ended on Sun 20 Sep 2026 with 2 sessions unused, so there is no next session to call about.");
    expect(next(pack({ status: "expired", expiresOn: null })).reason).toBe("Their package for LHR Full Legs has expired in Zenoti with 2 sessions unused, so there is no next session to call about.");
    expect(next(pack({ status: "cancelled" })).reason).toBe("Their package for LHR Full Legs was cancelled in Zenoti with 2 sessions unused, so there is no next session to call about.");
    expect(next(pack({ status: "frozen" }))).toMatchObject({ verdict: "kept_out", reason: "Their package for LHR Full Legs is on hold in Zenoti with 2 sessions left, so no call about the next session while it is." });
    // Even when Zenoti gave no count of sessions left.
    expect(next(pack({ status: "expired", expiresOn: null, total: null, used: null, balance: null })).reason).toBe("Their package for LHR Full Legs has expired in Zenoti, so there is no next session to call about.");
  });

  it("ignores a package that ended before their last visit, or gives no count of sessions, and prefers one with sessions left", () => {
    const after = journey(plan({ visits: [laser("2026-09-10")], packages: [pack({ status: "expired", expiresOn: "2026-09-01" })] }), "next_session");
    expect(after.verdict).toBe("waiting");
    expect(after.callAt).toEqual(ist("2026-10-15 10:00"));
    expect(only(plan({ visits: [laser("2026-08-01")], packages: [pack({ status: "not_started", total: null, used: null, balance: null })] })).reason).toMatch(/^Session 2 of 6/);
    const both = only(plan({ visits: [laser("2026-08-01")], packages: [pack({ status: "expired", expiresOn: "2026-09-15" }), pack({ total: 6, used: 1, balance: 5 })] }));
    expect(both).toMatchObject({ journey: "next_session", verdict: "call_now" });
    expect(both.reason).toMatch(/^Session 2 of 6 of LHR Full Legs/);
  });

  it("books the first session of a course bought again, not maintenance for the one it replaces", () => {
    // Zenoti has no "completed": the used-up package stays Active beside the one bought again, not started yet.
    const usedUp = pack({ used: 5, balance: 0 });
    const again = pack({ status: "not_started", used: 0, balance: 5, expiresOn: "2027-06-01" });
    for (const packages of [[usedUp, again], [again, usedUp]]) {
      const r = only(plan({ visits: [laser("2026-08-01")], packages }));
      expect(r).toMatchObject({ journey: "next_session", verdict: "call_now" });
      expect(r.reason).toBe(`Session 1 of 5 of LHR Full Legs is due 35 days after the last, on Sat 1 Aug 2026. 5 sessions left on the package they bought, not started yet, which ends on Tue 1 Jun 2027.${DEFAULT_NOTE}`);
    }
    // One being used still speaks before one not started.
    expect(only(plan({ visits: [laser("2026-08-01")], packages: [again, pack()] })).reason).toMatch(/^Session 4 of 5 .* 2 sessions left on their package, which ends on Mon 1 Mar 2027\./);
    // Alone, used up, it is maintenance as before.
    expect(only(plan({ visits: [laser("2026-06-01")], packages: [usedUp] })).journey).toBe("maintenance");
  });

  it("matches a package for a whole category by the visit's category, and one for a tag never", () => {
    const v = visit({ service: "LHR Full Legs", visitDate: "2026-08-01", categories: ["Laser", "Hair Reduction"] });
    expect(only(plan({ visits: [v], packages: [pack({ service: "hair reduction", covers: "category" })] })).reason).toMatch(/^Session 4 of 5 of LHR Full Legs/);
    // A tag, a category the visit is not in, or a category named like the service: the rule and the visits decide.
    for (const p of [pack({ service: "Hair Reduction", covers: "tag" }), pack({ service: "Facials", covers: "category" }), pack({ covers: "category" })]) {
      expect(only(plan({ visits: [v], packages: [p] })).reason, JSON.stringify(p)).toMatch(/^Session 2 of 6/);
    }
  });

  it("says when a service with sessions left has no gap set between sessions", () => {
    const r = only(plan({ visits: [visit({ service: "HIFU Face", visitDate: "2026-08-01" })], packages: [pack({ service: "HIFU Face", total: 2, used: 1, balance: 1 })] }));
    expect(r).toMatchObject({
      journey: "next_session",
      verdict: "kept_out",
      reason: "1 session of HIFU Face left on their package, but no gap between sessions is set for it, so JENAI cannot tell when the next is due. Add one in the treatment rules.",
    });
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
    expect(planSettingsOf({ packageEndingWithinDays: 7 }).packageEndingWithinDays).toBe(7);
    expect(planSettingsOf({ packageEndingWithinDays: 500 }).packageEndingWithinDays).toBe(30);
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

describe("replanning a client with a front desk system", () => {
  let org = "";
  let zenoti = "";
  let kondapur = "";
  const ids: Record<string, string> = {};
  const phone = (k: number) => `+91980000${String(k).padStart(4, "0")}`;

  beforeAll(async () => {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name: "Front Desk Clinic", slug: `front-desk-${randomUUID().slice(0, 8)}`, status: "active", vertical: "dermatology", languages: ["en"] })
      .returning({ id: organizations.id });
    org = o!.id;
    await withTenant(org, async (tx) => {
      const [b] = await tx.insert(branches).values({ tenantId: org, name: "Kondapur", languages: ["en"] }).returning();
      kondapur = b!.id;
      const [zoho] = await tx.insert(integrations).values({ tenantId: org, kind: "zoho_crm", name: "Zoho" }).returning();
      const [desk] = await tx.insert(integrations).values({ tenantId: org, kind: "zenoti", name: "Zenoti", direction: "in" }).returning();
      zenoti = desk!.id;
      for (const programKey of ["clinic.appointment_reminder", "clinic.warm_followup", "clinic.feedback", "clinic.prescription_followup", "clinic.revisit_recall"])
        await tx.insert(clientPrograms).values({ tenantId: org, programKey, programVersion: 1, name: programKey });
      const rec = (externalId: string, p: string, appointmentAt: string) => ({
        tenantId: org,
        integrationId: zoho!.id,
        module: "Leads",
        externalId,
        phoneE164: p,
        name: "Patient",
        status: "Appointment Booked",
        appointmentAt: ist(appointmentAt),
        createdExt: ist("2026-09-20 10:00"),
      });
      // 1 is booked in Zoho and in Zenoti for the same visit; 4 was booked in Zoho for a day that has passed, and came in two days later.
      for (const r of await tx.insert(crmRecords).values([rec("1", phone(1), "2026-10-02 11:00"), rec("4", phone(4), "2026-09-25 11:00")]).returning()) ids[`zoho${r.externalId}`] = r.id;
      const appt = (externalId: string, guestRef: string, p: string | null, status: ClinicAppointmentStatus, at: string, service = "Hydrafacial") => ({
        tenantId: org,
        integrationId: zenoti,
        externalId,
        guestRef,
        phoneE164: p,
        name: "Patient",
        service,
        startsAt: ist(at),
        status,
        doctor: "Dr. Asha",
        centreRef: "zenoti-centre",
        branchId: b!.id,
      });
      const made = await tx
        .insert(clinicAppointments)
        .values([
          appt("a1", "g1", phone(1), "booked", "2026-10-02 11:00"),
          appt("a2", "g2", phone(2), "no_show", "2026-09-26 16:30", "PRP - Hair"),
          appt("a3", "g3", phone(3), "cancelled", "2026-09-28 11:00", "Consultation"),
          // No number on the booking, but their guest record has one.
          appt("a6", "g6", null, "booked", "2026-10-05 12:00"),
          // No number anywhere: left out.
          appt("a7", "g7", null, "booked", "2026-10-05 12:00"),
        ])
        .returning();
      for (const a of made) ids[a.externalId] = a.id;
      const seen = (externalId: string, guestRef: string, p: string, service: string, visitDate: string) => ({ tenantId: org, integrationId: zenoti, externalId, guestRef, phoneE164: p, name: "Patient", service, visitDate, source: "api" });
      for (const v of await tx.insert(visits).values([seen("v4", "g4", phone(4), "Hydrafacial", "2026-09-27"), seen("v5", "g5", phone(5), "LHR Full Legs", "2026-09-30")]).returning()) ids[v.externalId!] = v.id;
      // 5's laser package, read before their number: it ends within the month.
      await tx.insert(packageBalances).values({ tenantId: org, integrationId: zenoti, guestRef: "g5", phoneE164: null, packageName: "LHR 5 Sessions", service: "LHR Full Legs", total: 5, used: 3, balance: 2, status: "active", expiresOn: "2026-10-12" });
      const guest = (externalId: string, p: string, marketingSmsConsent: boolean | null) => ({ tenantId: org, integrationId: zenoti, externalId, phoneE164: p, marketingSmsConsent });
      await tx.insert(externalPeople).values([
        guest("g2", phone(2), true),
        guest("g3", phone(3), false),
        guest("g5", phone(5), true),
        guest("g6", phone(6), null),
        // Agreed, but nothing in the plan for them.
        guest("g8", phone(8), true),
      ]);
    });
  });

  afterAll(async () => {
    await platformDb().delete(organizations).where(eq(organizations.id, org));
  });

  const stored = () =>
    withTenant(org, async (tx) =>
      (await tx.select().from(plannedCalls)).map(({ computedAt: _, ...r }) => r).sort((a, b) => `${a.originId}${a.journey}`.localeCompare(`${b.originId}${b.journey}`)),
    );
  const of = (rows: Awaited<ReturnType<typeof stored>>, key: string, j: string) => rows.find((r) => r.originId === ids[key] && r.journey === j);

  it("plans bookings, missed bookings and package sessions from Zenoti, counts consent, and gives the same rows when run again", async () => {
    const first = await replanTenant(org, { now: NOW });
    expect(first).toMatchObject({ people: 6, removed: 0, waitingForPhone: 0, marketingConsent: 2 });
    expect(first.byJourney.appointment_reminder).toEqual({ scheduled: 2, kept_out: 1 });
    expect(first.byJourney.no_show_rebook).toEqual({ call_now: 1 });
    expect(first.byJourney.cancelled_rebook).toEqual({ call_now: 1 });
    expect(first.byJourney.next_session).toEqual({ call_now: 1 });
    expect(first.byJourney.appointment_unclear).toBeUndefined();

    const rows = await stored();
    expect(rows).toHaveLength(first.rows);
    expect(of(rows, "a1", "appointment_reminder")).toMatchObject({
      verdict: "scheduled",
      originType: "clinic_appointment",
      originLabel: "Zenoti booking",
      phoneE164: phone(1),
      reason: "Appointment on Fri 2 Oct 2026 at 11:00 AM for Hydrafacial, booked in Zenoti.",
      context: { caller_name: "Patient", appointment_date: "2026-10-02", appointment_time: "11:00 AM", doctor: "Dr. Asha", branch: "Kondapur" },
    });
    expect(of(rows, "a1", "appointment_reminder")!.callAt).toEqual(ist("2026-10-01 18:00"));
    expect(of(rows, "zoho1", "appointment_reminder")).toMatchObject({ verdict: "kept_out", reason: "Booked in Zenoti for Fri 2 Oct 2026 at 11:00 AM: the reminder goes by Zenoti, the clinic's own system." });
    expect(of(rows, "a2", "no_show_rebook")).toMatchObject({ verdict: "call_now", reason: "Missed their appointment on Sat 26 Sep 2026 for PRP - Hair." });
    expect(of(rows, "a3", "cancelled_rebook")).toMatchObject({ verdict: "call_now", priority: 25, programKey: "clinic.warm_followup", reason: "Cancelled their appointment for Consultation booked for Mon 28 Sep 2026." });
    expect(rows.some((r) => r.originId === ids.zoho4)).toBe(false);
    expect(of(rows, "v4", "visit_feedback")?.verdict).toBe("call_now");
    expect(of(rows, "v5", "next_session")).toMatchObject({
      verdict: "call_now",
      reason: "2 sessions left, package ends on Mon 12 Oct 2026: called now so they can book before it does. Session 4 of 5 of LHR Full Legs is next; the last was on Wed 30 Sep 2026.",
    });
    expect(of(rows, "a6", "appointment_reminder")).toMatchObject({ verdict: "scheduled", phoneE164: phone(6) });
    expect(of(rows, "a6", "appointment_reminder")!.callAt).toEqual(ist("2026-10-03 18:00"));
    expect(rows.some((r) => r.originId === ids.a7)).toBe(false);
    // The count of consents is a number only, and no call is made of it.
    expect(JSON.stringify(first)).not.toMatch(/\+91|Patient/);

    const again = await replanTenant(org, { now: NOW });
    expect(again).toEqual(first);
    expect(await stored()).toEqual(rows);
  });

  it("follows Zenoti as it changes: booked again, cancelled, a no-show gone, a package used up", async () => {
    await withTenant(org, async (tx) => {
      const [a] = await tx.select().from(clinicAppointments).where(eq(clinicAppointments.id, ids.a3!));
      const [a9] = await tx
        .insert(clinicAppointments)
        .values({ ...a!, id: undefined, externalId: "a9", status: "booked", service: "Consultation", startsAt: ist("2026-10-06 10:00"), updatedAt: undefined })
        .returning();
      ids.a9 = a9!.id;
      await tx.update(clinicAppointments).set({ status: "cancelled" }).where(eq(clinicAppointments.id, ids.a1!));
      await tx.delete(clinicAppointments).where(eq(clinicAppointments.id, ids.a2!));
      await tx.update(packageBalances).set({ used: 5, balance: 0 }).where(eq(packageBalances.integrationId, zenoti));
    });
    const r = await replanTenant(org, { now: NOW });
    // Gone: 1's reminder from the booking now cancelled, and 5's next session. 2's no-show call went with the booking, when it was deleted.
    expect(r.removed).toBe(2);
    const rows = await stored();
    expect(of(rows, "a3", "cancelled_rebook")).toMatchObject({ verdict: "kept_out", reason: "Cancelled their appointment for Consultation booked for Mon 28 Sep 2026, but is booked again for Tue 6 Oct 2026." });
    expect(of(rows, "a9", "appointment_reminder")?.verdict).toBe("scheduled");
    expect(of(rows, "zoho1", "appointment_reminder")).toMatchObject({ verdict: "kept_out", reason: "Cancelled in Zenoti for Fri 2 Oct 2026 at 11:00 AM: no reminder, as Zenoti is the clinic's own system." });
    expect(of(rows, "a1", "cancelled_rebook")).toMatchObject({ verdict: "call_now", reason: "Cancelled their appointment for Hydrafacial booked for Fri 2 Oct 2026." });
    expect(rows.some((x) => x.originId === ids.a2)).toBe(false);
    expect(of(rows, "v5", "next_session")).toBeUndefined();
    // Maintenance, six months on, waiting behind the feedback call on the visit.
    expect(of(rows, "v5", "maintenance")).toMatchObject({ verdict: "waiting", callAt: ist("2027-03-29 10:00") });
  });

  it("plans a visit read before its number by its guest's number once known, unless it copies a visit they have", async () => {
    await withTenant(org, async (tx) => {
      await tx.insert(externalPeople).values({ tenantId: org, integrationId: zenoti, externalId: "g12", phoneE164: phone(12) });
      const line = (externalId: string, service: string, visitDate: string) => ({ tenantId: org, integrationId: zenoti, externalId, guestRef: "g12", service, visitDate, source: "api" });
      for (const v of await tx.insert(visits).values([line("v12", "Peel", "2026-09-29"), line("v13", "Hydrafacial", "2026-09-27")]).returning()) ids[v.externalId!] = v.id;
      // Their uploaded visit list already has the Hydrafacial that day.
      const [up] = await tx.insert(visits).values({ tenantId: org, phoneE164: phone(12), service: "hydrafacial", visitDate: "2026-09-27", source: "upload" }).returning();
      ids.up12 = up!.id;
    });
    const r = await replanTenant(org, { now: NOW });
    expect(r.waitingForPhone).toBe(0);
    const rows = await stored();
    expect(of(rows, "v12", "visit_feedback")).toMatchObject({ phoneE164: phone(12) });
    expect(rows.some((x) => x.originId === ids.v13)).toBe(false);
    expect(rows.some((x) => x.originId === ids.up12)).toBe(true);
  });

  it("names a centre alike for bookings and visits: the JENAI branch, else as Zenoti does", async () => {
    await withTenant(org, async (tx) => {
      await tx
        .update(integrations)
        .set({ config: { centres: [{ id: "zenoti-centre", name: "Zennara Clinics - Kondapur", code: "ZNKD" }, { id: "gachibowli", name: "Zennara Clinics - Gachibowli", code: "ZNGB" }] } })
        .where(eq(integrations.id, zenoti));
      // Stored under Zenoti's name for the centre, which is JENAI's Kondapur branch.
      const [v] = await tx
        .insert(visits)
        .values({ tenantId: org, integrationId: zenoti, externalId: "v14", guestRef: "g14", phoneE164: phone(14), service: "Hydrafacial", visitDate: "2026-09-30", branch: "Zennara Clinics - Kondapur", branchId: kondapur, centreRef: "zenoti-centre", source: "api" })
        .returning();
      ids.v14 = v!.id;
      // At a centre that is no JENAI branch.
      const [a] = await tx
        .insert(clinicAppointments)
        .values({ tenantId: org, integrationId: zenoti, externalId: "a15", guestRef: "g15", phoneE164: phone(15), service: "Peel", startsAt: ist("2026-10-05 11:00"), status: "booked", centreRef: "gachibowli" })
        .returning();
      ids.a15 = a!.id;
      await tx.insert(callPlanSettings).values({ tenantId: org, settings: { centres: ["Kondapur"] } });
    });
    await replanTenant(org, { now: NOW });
    const rows = await stored();
    expect(of(rows, "v14", "visit_feedback")).toMatchObject({ verdict: "scheduled", context: { branch: "Kondapur" } });
    expect(of(rows, "a1", "appointment_reminder")?.verdict).not.toBe("kept_out");
    expect(of(rows, "a15", "appointment_reminder")).toMatchObject({ verdict: "kept_out", reason: "For the Zennara Clinics - Gachibowli centre, which this plan does not cover." });
    await withTenant(org, (tx) => tx.delete(callPlanSettings));
  });
});
