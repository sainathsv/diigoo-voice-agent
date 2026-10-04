/**
 * The call plan: for every person in a client's records, which call JENAI
 * would make, when and why, or why it would not call them at all.
 *
 * Three sources: the client's CRM as last read (crm_records: enquiries,
 * callbacks, appointments), the services people actually took (visits, from
 * the clinic's own software), and what their front desk system (Zenoti) says
 * besides: bookings coming up, missed or cancelled (clinic_appointments), and
 * sessions left on packages (package_balances). planPerson() decides for one
 * person and is pure; replanTenant() reads one client's sources, plans
 * everyone and stores the result in planned_calls.
 *
 * This is a preview. Nothing here dials, creates campaign targets or writes to
 * the client's CRM. No promotional call is ever planned: an offer needs a
 * promotional number and recorded consent, which a plan cannot assume. The
 * SMS consents read from a front desk system are counted, never planned on.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  branches,
  callPlanSettings,
  calls,
  clientPrograms,
  clinicAppointments,
  contacts,
  crmRecords,
  externalPeople,
  integrations,
  organizations,
  packageBalances,
  plannedCalls,
  suppressionReason,
  suppressions,
  treatmentRules,
  visits,
  withTenant,
  type ClinicAppointmentStatus,
  type PackageStatus,
  type PlanOriginType,
  type PlannedCallVerdict,
  type TreatmentRule,
} from "@jenai/db";
import { END_GUARD_MIN, effectiveWindow, localParts, nextWindowStart, zoned, type Windows } from "./dialer/time";
import { verticalOf } from "./safety/cases";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** An appointment later the same day is reminded this long before. */
const SAME_DAY_REMINDER_MS = 3 * HOUR_MS;
/** Closer than this, a reminder call is more nuisance than help. */
const REMINDER_CUTOFF_MS = 2 * HOUR_MS;
/** A new enquiry this fresh is called before other enquiries: people book soonest after they ask. */
const SPEED_TO_LEAD_MS = DAY_MS;
const NOT_SET_UP = " (call script not added to this workspace yet)";

// ---------------------------------------------------------------- journeys

/**
 * Every kind of call the plan makes, highest priority first. The order is the
 * one-call-per-person order too. appointment_unclear and no_call are never
 * called: they say why a record prompts no call.
 */
export const PLAN_JOURNEYS = {
  appointment_reminder: { program: "clinic.appointment_reminder", label: "Remind them of their appointment", priority: 90 },
  after_consultation: { program: "clinic.prescription_followup", label: "Check in after their consultation", priority: 80 },
  result_check: { program: "clinic.prescription_followup", label: "Ask how they are doing and whether they see a difference", priority: 70 },
  visit_feedback: { program: "clinic.feedback", label: "Ask how their visit went", priority: 60 },
  callback_due: { program: "clinic.warm_followup", label: "Call back on the date the team noted", priority: 50 },
  new_enquiry: { program: "clinic.warm_followup", label: "Call to book a consultation", priority: 40 },
  no_show_rebook: { program: "clinic.warm_followup", label: "They missed their appointment: call to rebook", priority: 30 },
  cancelled_rebook: { program: "clinic.warm_followup", label: "They cancelled: call to rebook", priority: 25 },
  next_session: { program: "clinic.revisit_recall", label: "Book their next session", priority: 20 },
  maintenance: { program: "clinic.revisit_recall", label: "Book their maintenance session", priority: 10 },
  appointment_unclear: { program: "", label: "Appointment outcome unknown", priority: 0 },
  no_call: { program: "", label: "No call", priority: 0 },
} as const;
export type PlanJourney = keyof typeof PLAN_JOURNEYS;

/** Priority given to a new enquiry made within the last day: above every other enquiry call. */
const FRESH_ENQUIRY_PRIORITY = 55;

/** Calls whose point is to get them booked: an appointment already coming up makes them wait. */
const BOOKING_JOURNEYS = new Set<PlanJourney>(["callback_due", "new_enquiry", "no_show_rebook", "cancelled_rebook", "next_session", "maintenance"]);

/** The variables each program's script fills in (packages/db/seed-data/programs). */
const PROGRAM_VARIABLES: Record<string, readonly string[]> = {
  "clinic.warm_followup": ["caller_name", "enquiry_about", "enquiry_date", "enquiry_source", "branch"],
  "clinic.appointment_reminder": ["caller_name", "appointment_date", "appointment_time", "doctor", "branch"],
  "clinic.prescription_followup": ["caller_name", "visit_date", "treatment", "doctor", "review_due"],
  "clinic.feedback": ["caller_name", "visit_date", "doctor", "branch"],
  "clinic.revisit_recall": ["caller_name", "treatment", "last_visit", "doctor"],
};

// ---------------------------------------------------------------- settings

export interface PlanSettings {
  /** An enquiry older than this many days is a cold call, which the plan never makes. */
  freshDays: number;
  /** CRM statuses, as the client words them; matched ignoring case, spaces and punctuation. */
  openStatuses: string[];
  bookedStatuses: string[];
  noShowStatuses: string[];
  customerStatuses: string[];
  /** This record prompts no call. */
  neverStatuses: string[];
  /** The person, not only this record, is not to be called. */
  doNotCallStatuses: string[];
  /** Centres this plan covers. Empty: all. */
  centres: string[];
  /** No planned call within this many days of the person's last call. */
  minGapDays: number;
  /** Hour of the evening before an appointment the reminder is made, local time. */
  reminderHour: number;
  callingWindow: Windows;
  /** CRM modules that are only a list of people (Zoho Contacts): a record there alone prompts no call. */
  contactOnlyModules: string[];
  /** A consultation older than this prompts no check-in. */
  consultationWithinDays: number;
  /** The check-in after a consultation, this many days after it. */
  checkInAfterDays: number;
  /** Feedback on a visit is asked only while the visit is this recent. */
  feedbackWithinDays: number;
  /** A result check is made only this many days past its due date. */
  resultCheckWithinDays: number;
  /** A package with sessions left that ends within this many days is called about now, not at the usual gap. */
  packageEndingWithinDays: number;
  /** The client's time zone, from their organisation. Not a setting they edit here. */
  timezone: string;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  freshDays: 30,
  openStatuses: ["New Lead", "Interested", "Not Answered", "Follow-up"],
  bookedStatuses: ["Appointment Booked"],
  noShowStatuses: ["No Show"],
  customerStatuses: ["Converted", "Existing Client"],
  neverStatuses: ["Junk Lead", "Not Interested", "Invalid", "Do Not Call"],
  doNotCallStatuses: ["Do Not Call"],
  centres: [],
  minGapDays: 3,
  reminderHour: 18,
  callingWindow: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" },
  contactOnlyModules: ["Contacts"],
  consultationWithinDays: 60,
  checkInAfterDays: 3,
  feedbackWithinDays: 14,
  resultCheckWithinDays: 30,
  packageEndingWithinDays: 30,
  timezone: "Asia/Kolkata",
};

type NumberKey = "freshDays" | "minGapDays" | "reminderHour" | "consultationWithinDays" | "checkInAfterDays" | "feedbackWithinDays" | "resultCheckWithinDays" | "packageEndingWithinDays";
type ListKey = "openStatuses" | "bookedStatuses" | "noShowStatuses" | "customerStatuses" | "neverStatuses" | "doNotCallStatuses" | "centres" | "contactOnlyModules";
const NUMBER_LIMITS: Record<NumberKey, [number, number]> = {
  freshDays: [1, 365],
  minGapDays: [0, 60],
  reminderHour: [0, 23],
  consultationWithinDays: [1, 365],
  checkInAfterDays: [0, 60],
  feedbackWithinDays: [1, 90],
  resultCheckWithinDays: [1, 180],
  packageEndingWithinDays: [0, 180],
};
const LIST_KEYS: ListKey[] = ["openStatuses", "bookedStatuses", "noShowStatuses", "customerStatuses", "neverStatuses", "doNotCallStatuses", "centres", "contactOnlyModules"];

/**
 * A client's plan settings (call_plan_settings.settings) over the defaults.
 * A key that is missing or not usable keeps its default, so a typo in one
 * setting cannot stop the plan.
 */
export function planSettingsOf(raw: unknown, timezone = DEFAULT_PLAN_SETTINGS.timezone): PlanSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const s: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, timezone };
  for (const k of Object.keys(NUMBER_LIMITS) as NumberKey[]) {
    const v = r[k];
    const [min, max] = NUMBER_LIMITS[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) s[k] = v;
  }
  for (const k of LIST_KEYS) {
    const v = r[k];
    if (Array.isArray(v)) s[k] = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
  }
  s.callingWindow = windowOf(r.callingWindow) ?? DEFAULT_PLAN_SETTINGS.callingWindow;
  return s;
}

function windowOf(v: unknown): Windows | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const hhmm = (x: unknown) => typeof x === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  if (!Array.isArray(w.days) || !hhmm(w.start) || !hhmm(w.end)) return null;
  const days = [...new Set(w.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))];
  const out: Windows = { days, start: w.start as string, end: w.end as string };
  // A window with no time left in it once clipped to the legal hours would leave nothing callable.
  const { start, end } = effectiveWindow(out);
  return days.length && end - END_GUARD_MIN > start ? out : null;
}

// ---------------------------------------------------------------- treatment rules

export interface PlanRule {
  /** Words looked for in the service name, ignoring case. Empty: the rule for a service no other rule matches. */
  match: string[];
  label: string;
  feedbackAfterDays: number | null;
  resultCheckAfterDays: number | null;
  sessionIntervalDays: number | null;
  courseSessions: number | null;
  maintenanceAfterDays: number | null;
  /** JENAI's starting timing, until the clinic's doctors confirm or change it. */
  isDefault: boolean;
}

/** Feedback on any visit, two days after it, unless the clinic says otherwise. */
const FEEDBACK_AFTER_DAYS = 2;

const byDefault = (match: string[], label: string, t: Partial<PlanRule> = {}): PlanRule => ({
  match,
  label,
  feedbackAfterDays: FEEDBACK_AFTER_DAYS,
  resultCheckAfterDays: null,
  sessionIntervalDays: null,
  courseSessions: null,
  maintenanceAfterDays: null,
  ...t,
  isDefault: true,
});

/**
 * Starting timings for skin and hair clinics. EVERY ONE IS A DEFAULT for the
 * clinic's doctors to confirm or change in treatment_rules; none is medical
 * advice, and the plan says so wherever one is used. A clinic's own rule for
 * a service always wins over these.
 */
export const DEFAULT_HEALTH_RULES: readonly PlanRule[] = [
  byDefault(["laser hair", "lhr"], "Laser hair removal", { resultCheckAfterDays: 14, sessionIntervalDays: 35, courseSessions: 6, maintenanceAfterDays: 180 }),
  byDefault(["laser toning", "toning"], "Laser toning", { resultCheckAfterDays: 10, sessionIntervalDays: 21, courseSessions: 6, maintenanceAfterDays: 90 }),
  byDefault(["hifu"], "HIFU", { resultCheckAfterDays: 30, maintenanceAfterDays: 365 }),
  byDefault(["medifacial", "facial"], "Medifacial or facial", { resultCheckAfterDays: 7, sessionIntervalDays: 30, maintenanceAfterDays: 30 }),
  byDefault(["peel"], "Peel", { resultCheckAfterDays: 7, sessionIntervalDays: 21, courseSessions: 4 }),
  byDefault(["prp", "gfc", "hair"], "PRP, GFC or hair treatment", { resultCheckAfterDays: 30, sessionIntervalDays: 30, courseSessions: 4 }),
  byDefault(["acne"], "Acne treatment", { resultCheckAfterDays: 14 }),
  byDefault(["pigmentation"], "Pigmentation treatment", { resultCheckAfterDays: 14, sessionIntervalDays: 21 }),
  byDefault(["mole", "wart", "lesion"], "Mole, wart or lesion removal", { resultCheckAfterDays: 7 }),
  byDefault(["iv drip", "drip"], "IV drip", { sessionIntervalDays: 30 }),
  byDefault(["body contouring", "contouring"], "Body contouring", { resultCheckAfterDays: 14, sessionIntervalDays: 7, courseSessions: 6 }),
];

/** Any other service: feedback, and a check on how they are doing. Also a default for the doctors to confirm. */
export const FALLBACK_RULE: PlanRule = byDefault([], "Any other service", { resultCheckAfterDays: 10 });

/** The rules one client plans with: their own first, then their industry's defaults, then the fallback. */
export function treatmentRulesFor(own: readonly TreatmentRule[], vertical: string | null | undefined): PlanRule[] {
  const theirs = own
    .filter((r) => r.match.trim())
    .map<PlanRule>((r) => ({
      match: [r.match.trim().toLowerCase()],
      label: r.label,
      feedbackAfterDays: r.feedbackAfterDays ?? FEEDBACK_AFTER_DAYS,
      resultCheckAfterDays: r.resultCheckAfterDays,
      sessionIntervalDays: r.sessionIntervalDays,
      courseSessions: r.courseSessions,
      maintenanceAfterDays: r.maintenanceAfterDays,
      isDefault: false,
    }));
  return [...theirs, ...(verticalOf(vertical) === "health" ? DEFAULT_HEALTH_RULES : []), FALLBACK_RULE];
}

/** The rule for a service: the clinic's own before a default, then the longest word found, so "laser hair" beats "hair". */
export function ruleFor(service: string, rules: readonly PlanRule[]): PlanRule {
  const s = service.toLowerCase();
  let best: PlanRule | null = null;
  let score = 0;
  for (const r of rules) {
    for (const m of r.match) {
      const sc = (r.isDefault ? 0 : 1000) + m.length;
      if (m && s.includes(m) && sc > score) [best, score] = [r, sc];
    }
  }
  return best ?? rules.find((r) => !r.match.length) ?? FALLBACK_RULE;
}

// ---------------------------------------------------------------- one person

/** A CRM record as the plan reads it (a crm_records row). */
export interface PlanRecord {
  id: string;
  module: string;
  /** The system it came from, as the clinic knows it: "Zoho". */
  crm?: string;
  phoneE164?: string | null;
  name?: string | null;
  status?: string | null;
  source?: string | null;
  centre?: string | null;
  createdExt?: Date | null;
  appointmentAt?: Date | null;
  followUpAt?: Date | null;
  treatment?: string | null;
  consultant?: string | null;
}

/** A service someone took (a visits row). */
export interface PlanVisit {
  id: string;
  phoneE164: string;
  name?: string | null;
  service: string;
  /** "2026-10-01" */
  visitDate: string;
  doctor?: string | null;
  branch?: string | null;
  sessionsDone?: number | null;
  sessionsTotal?: number | null;
  source?: string;
  /** The service's category and sub-category in their system, for a package that covers a whole category. */
  categories?: string[] | null;
}

/** A booking in the clinic's front desk system (a clinic_appointments row). */
export interface PlanBooking {
  id: string;
  /** The system it came from, as the clinic knows it: "Zenoti". */
  system?: string;
  name?: string | null;
  service: string;
  startsAt: Date;
  status: ClinicAppointmentStatus;
  doctor?: string | null;
  /** The branch it is at, by name. */
  centre?: string | null;
}

/** Sessions on one package for one service in it (a package_balances row). */
export interface PlanPackage {
  /** The system it came from, as the clinic knows it: "Zenoti". */
  system?: string;
  /** A service's name, or a category's or a tag's, as `covers` says. */
  service: string;
  /** What the line pays for: one service (the default), any service in a category, or any with a tag. */
  covers?: "service" | "category" | "tag";
  total?: number | null;
  used?: number | null;
  balance?: number | null;
  status: PackageStatus;
  /** "2026-12-31" */
  expiresOn?: string | null;
}

export type SuppressionReason = (typeof suppressionReason.enumValues)[number];

/** Everything known about one person: every record, visit, booking and package with their number. */
export interface PlanPerson {
  /** Their number in E.164, or null for a record whose number could not be read. */
  phone: string | null;
  records: PlanRecord[];
  visits: PlanVisit[];
  /** Bookings in their front desk system, whatever came of them. */
  bookings?: PlanBooking[];
  /** Packages in their front desk system, one per service in each. */
  packages?: PlanPackage[];
  /** Live do-not-call entries for the number, the client's and the platform's. */
  suppressions?: Array<{ reason: SuppressionReason; expiresAt?: Date | null }>;
  /** Their last call with this client, either way. */
  lastCallAt?: Date | null;
  contactId?: string | null;
  /** Call programs this workspace has set up. Left out, scripts are not checked. */
  programs?: ReadonlySet<string>;
}

/** One planned_calls row. */
export interface PlanRow {
  originType: PlanOriginType;
  originId: string;
  originLabel: string;
  journey: PlanJourney;
  programKey: string;
  verdict: PlannedCallVerdict;
  /** Plain English, for the clinic. */
  reason: string;
  callAt: Date | null;
  priority: number;
  phoneE164: string | null;
  name: string | null;
  contactId: string | null;
  /** The variables the call's script needs. Empty for someone kept out. */
  context: Record<string, string>;
}

const SUPPRESSION_TEXT: Record<SuppressionReason, string> = {
  opt_out: "Asked not to be called.",
  complaint: "Made a complaint, so is not to be called.",
  legal: "Not to be called, for legal reasons.",
  wrong_number: "Wrong number: this number is not theirs.",
  dnd_registry: "On the national Do Not Disturb register.",
};
/** When a number has several entries, the one the clinic most needs to see. */
const SUPPRESSION_ORDER: SuppressionReason[] = ["opt_out", "complaint", "legal", "wrong_number", "dnd_registry"];

type Values = Record<string, string | null | undefined>;

interface Origin {
  type: PlanOriginType;
  id: string;
  label: string;
  name: string | null;
  centre: string | null;
}

interface Draft {
  origin: Origin;
  journey: PlanJourney;
  verdict: PlannedCallVerdict;
  reason: string;
  callAt: Date | null;
  priority: number;
  values: Values;
}

interface Ctx {
  s: PlanSettings;
  rules: readonly PlanRule[];
  now: Date;
  tz: string;
  today: string;
  lastCallAt: Date | null;
  personName: string | null;
  packages: readonly PlanPackage[];
}

/** A visit as the plan reads it, uploaded or read off a customer's CRM record. */
interface VisitIn {
  origin: Origin;
  service: string;
  day: string;
  doctor: string | null;
  branch: string | null;
  sessionsDone: number | null;
  sessionsTotal: number | null;
  categories: string[];
}

/**
 * Every call the plan would make to one person, one row per thing that
 * prompts a call and kind of call, with when and why, or why not. Pure.
 *
 * At most one row comes out call_now or scheduled: the call that comes first.
 * The others wait for it. Do-not-call overrides everything.
 */
export function planPerson(person: PlanPerson, settings: PlanSettings, rules: readonly PlanRule[], now: Date): PlanRow[] {
  const tz = settings.timezone;
  const bookings = person.bookings ?? [];
  const c: Ctx = {
    s: settings,
    rules,
    now,
    tz,
    today: dayOf(now, tz),
    lastCallAt: person.lastCallAt ?? null,
    personName: person.records.find((r) => r.name)?.name ?? person.visits.find((v) => v.name)?.name ?? bookings.find((b) => b.name)?.name ?? null,
    packages: person.packages ?? [],
  };
  const drafts: Draft[] = [];
  const uploaded = person.visits.filter((v) => v.visitDate <= c.today).map((v) => visitIn(v));
  const uploadedDays = new Set(uploaded.map((v) => v.day));
  const derived: VisitIn[] = [];
  const isContactOnly = (r: PlanRecord) => !statusOf(r.status) && inList(settings.contactOnlyModules, r.module);
  const hasEnquiry = person.records.some((r) => !isContactOnly(r));
  // Their front desk system is the clinic's own record of bookings: a reminder goes by it before any CRM's.
  const upcoming = bookings.filter((b) => isBooked(b.status) && b.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const frontDesk = upcoming[0];
  // A CRM booking whose date has passed is answered by a visit or a no-show at the front desk on or after it, or a cancellation there that day.
  const answered = (appt: Date) => {
    const day = dayOf(appt, tz);
    if (uploaded.some((v) => v.day >= day)) return true;
    return bookings.some((b) => {
      const d = dayOf(b.startsAt, tz);
      return ((b.status === "completed" || b.status === "no_show") && d >= day) || (b.status === "cancelled" && d === day);
    });
  };
  // A CRM booking still to come: the front desk's own booking, or its cancellation that day, speaks for it.
  const crmReminder = (o: Origin, appt: Date, values: Values) => {
    if (frontDesk) return byFrontDesk(o, frontDesk, c);
    const off = cancelledOn(bookings, appt, c);
    if (off) return keep("appointment_reminder", o, `Cancelled in ${systemOf(off)} for ${whenText(off.startsAt, c)}: no reminder, as ${systemOf(off)} is the clinic's own system.`);
    return reminderRow(appt, o, values, c);
  };
  const again = (at: Date) => bookedAgain(at, person.records, bookings, uploaded, c);

  for (const r of person.records) {
    const o = recordOrigin(r);
    const crm = r.crm ?? "their CRM";
    if (isContactOnly(r)) {
      if (!hasEnquiry && !uploaded.length && !bookings.length) drafts.push(keep("no_call", o, `Only in ${crm} ${r.module}: no enquiry or visit on record.`));
      continue;
    }
    switch (classOf(r.status, settings)) {
      case "never":
        drafts.push(keep("no_call", o, `Marked "${r.status}" in ${crm}.`));
        break;
      case "unknown":
        drafts.push(keep("no_call", o, `"${r.status}" is not a status the plan settings know, so JENAI cannot tell which call fits. Add it to one of the status lists.`));
        break;
      case "open":
        drafts.push(...enquiryRows(r, o, c));
        break;
      case "booked":
        // Still booked in their CRM, but the visit list or front desk shows what happened: that speaks for it.
        if (r.appointmentAt && r.appointmentAt <= now && answered(r.appointmentAt)) break;
        drafts.push(bookedRow(r, o, c, crmReminder));
        break;
      case "no_show":
        drafts.push(noShowRow(r, o, c, again));
        break;
      case "customer": {
        const appt = r.appointmentAt;
        if (appt && appt > now) drafts.push(crmReminder(o, appt, recordValues(r, c)));
        else if (appt) {
          // Their visit, unless the visit list already has that day.
          const day = dayOf(appt, tz);
          if (!uploadedDays.has(day))
            derived.push({ origin: o, service: r.treatment ?? "", day, doctor: r.consultant ?? null, branch: r.centre ?? null, sessionsDone: null, sessionsTotal: null, categories: [] });
        } else if (!uploaded.length) {
          drafts.push(keep("no_call", o, `${crm} has no visit date for this patient. Upload the visit list so JENAI knows what they had and when.`));
        }
        break;
      }
    }
  }

  drafts.push(...bookingRows(bookings, upcoming, again, c));
  const all = [...uploaded, ...derived];
  drafts.push(...visitRows(all, c));
  // Everyone shows in the plan, including a patient none of whose calls is due any more.
  if (!drafts.length && all.length) {
    const last = all.reduce((a, b) => (b.day > a.day ? b : a));
    drafts.push(keep("no_call", last.origin, `Last visit on ${dateText(last.day)}${last.service ? ` for ${last.service}` : ""}: no call about it is due any more.`));
  }
  if (!drafts.length && bookings.length) drafts.push(lastBookingRow(bookings, c));

  const live = (d: Draft) => d.verdict === "call_now" || d.verdict === "scheduled";
  const out = (d: Draft, reason: string) => Object.assign(d, { verdict: "kept_out" as const, reason, callAt: null, priority: 0 });

  // Where the clinic does not want calls made, or cannot make them.
  if (settings.centres.length)
    for (const d of drafts) if (live(d) && d.origin.centre && !inList(settings.centres, d.origin.centre)) out(d, `For the ${d.origin.centre} centre, which this plan does not cover.`);
  if (!person.phone) for (const d of drafts) if (live(d)) out(d, "No phone number JENAI can dial.");
  const dnc = person.records.find((r) => r.status && inList(settings.doNotCallStatuses, r.status));
  if (dnc) for (const d of drafts) out(d, `Marked "${dnc.status}" in ${dnc.crm ?? "their CRM"}.`);
  const stop = SUPPRESSION_ORDER.find((reason) => (person.suppressions ?? []).some((x) => x.reason === reason && (!x.expiresAt || x.expiresAt > now)));
  if (stop) for (const d of drafts) out(d, SUPPRESSION_TEXT[stop]);

  // One call at a time. With an appointment coming up, calls to get them booked wait for it.
  // Otherwise the call that comes first goes ahead: of those due now, the highest priority.
  const active = drafts.filter(live);
  const reminder = active.find((d) => d.journey === "appointment_reminder");
  const contenders = reminder ? active.filter((d) => !BOOKING_JOURNEYS.has(d.journey)) : active;
  const rank = (j: PlanJourney) => Object.keys(PLAN_JOURNEYS).indexOf(j);
  const first = [...contenders].sort((a, b) => a.callAt!.getTime() - b.callAt!.getTime() || rank(a.journey) - rank(b.journey))[0];
  for (const d of active) {
    if (d === first) continue;
    const ahead = reminder && BOOKING_JOURNEYS.has(d.journey) ? reminder : first!;
    Object.assign(d, { verdict: "waiting" as const, reason: `Another call to this person comes first: ${PLAN_JOURNEYS[ahead.journey].label}` });
  }

  const contactId = person.contactId ?? null;
  return drafts
    .map<PlanRow>((d) => {
      const programKey = PLAN_JOURNEYS[d.journey].program;
      const missing = person.programs && programKey && d.verdict !== "kept_out" && !person.programs.has(programKey);
      return {
        originType: d.origin.type,
        originId: d.origin.id,
        originLabel: d.origin.label,
        journey: d.journey,
        programKey,
        verdict: d.verdict,
        reason: missing ? d.reason + NOT_SET_UP : d.reason,
        callAt: d.callAt,
        priority: d.priority,
        phoneE164: person.phone,
        name: d.origin.name ?? c.personName,
        contactId,
        context: d.verdict === "kept_out" ? {} : contextOf(programKey, { ...d.values, caller_name: d.origin.name ?? c.personName }),
      };
    })
    .sort((a, b) => a.originType.localeCompare(b.originType) || a.originId.localeCompare(b.originId) || a.journey.localeCompare(b.journey));
}

/** An open enquiry: a check-in after their consultation, the callback the team noted, or the first call. */
function enquiryRows(r: PlanRecord, o: Origin, c: Ctx): Draft[] {
  const rows: Draft[] = [];
  const crm = r.crm ?? "their CRM";
  const F = c.s.freshDays;
  const values = recordValues(r, c);
  const appt = r.appointmentAt;
  if (appt && appt <= c.now && (r.consultant || /consult/i.test(r.treatment ?? ""))) {
    const day = dayOf(appt, c.tz);
    if (daysBetween(day, c.today) <= c.s.consultationWithinDays) {
      const still = r.status ? `still marked "${r.status}"` : "still an open enquiry";
      rows.push(
        callable("after_consultation", o, startOf(addDays(day, c.s.checkInAfterDays), c.tz), `Had a consultation on ${dateText(day)}${r.consultant ? ` with ${r.consultant}` : ""} and is ${still} in ${crm}.`, { ...values, visit_date: day }, c),
      );
    }
  }

  const created = r.createdExt ? dayOf(r.createdExt, c.tz) : null;
  const age = created ? Math.max(0, daysBetween(created, c.today)) : null;
  const fu = r.followUpAt ?? null;
  const fuDay = fu ? dayOf(fu, c.tz) : null;
  // A noted callback keeps an older enquiry warm, but only while the callback itself is recent.
  if (fu && fuDay && daysBetween(fuDay, c.today) <= F) {
    rows.push(callable("callback_due", o, fu, `The team noted a callback for ${dateText(fuDay)}${fu <= c.now ? ", and it is due" : ""}.`, values, c));
  } else if (age !== null && age <= F) {
    const fresh = c.now.getTime() - r.createdExt!.getTime() <= SPEED_TO_LEAD_MS;
    const when = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
    const about = r.treatment ? ` about ${r.treatment}` : "";
    const via = r.source ? ` through ${r.source}` : "";
    rows.push(
      callable("new_enquiry", o, c.now, `Enquired ${when}${about}${via}.${fresh ? " Called first: people book soonest right after they ask." : ""}`, values, c, {
        priority: fresh ? FRESH_ENQUIRY_PRIORITY : undefined,
      }),
    );
  } else if (fu && fuDay) {
    rows.push(keep("callback_due", o, `The team noted a callback for ${dateText(fuDay)}, ${plural(daysBetween(fuDay, c.today), "day")} ago. ${coldCall(F)}`));
  } else if (age === null) {
    rows.push(keep("new_enquiry", o, `${crm} has no enquiry date for this record, so JENAI cannot tell how recent it is.`));
  } else {
    rows.push(keep("new_enquiry", o, `Enquired ${plural(age, "day")} ago. ${coldCall(F)}`));
  }
  return rows;
}

const coldCall = (F: number) => `Older than ${F} days counts as a cold call, which needs a promotional number and consent.`;

function bookedRow(r: PlanRecord, o: Origin, c: Ctx, remind: (o: Origin, appt: Date, values: Values) => Draft): Draft {
  const crm = r.crm ?? "their CRM";
  if (!r.appointmentAt) return keep("appointment_reminder", o, `${crm} says booked but has no appointment date, so JENAI cannot remind them. Add the date in ${crm}.`);
  if (r.appointmentAt <= c.now) return keep("appointment_unclear", o, `Their appointment date has passed and ${crm} still says booked, so JENAI cannot tell if they came. Update the status in ${crm}.`);
  return remind(o, r.appointmentAt, recordValues(r, c));
}

/**
 * A reminder the evening before (the last calling day before, when the
 * evening before is not one), or 3 hours before an appointment later today.
 * Not moved by the gap between calls: they expect it, and it is tied to the day.
 */
function reminderRow(appt: Date, o: Origin, values: Values, c: Ctx, about = ""): Draft {
  const day = dayOf(appt, c.tz);
  const when = whenText(appt, c);
  if (appt.getTime() - c.now.getTime() < REMINDER_CUTOFF_MS) return keep("appointment_reminder", o, `Their appointment on ${when} is under 2 hours away: too close for a reminder call.`);
  let target: Date | null = null;
  if (day !== c.today) {
    for (let d = addDays(day, -1); d >= c.today && !target; d = addDays(d, -1))
      if (c.s.callingWindow.days.includes(weekday(d))) target = startOf(d, c.tz, c.s.reminderHour * 60);
  }
  target ??= new Date(appt.getTime() - SAME_DAY_REMINDER_MS);
  const due = target <= c.now;
  const at = nextWindowStart(due ? c.now : target, c.s.callingWindow, c.tz);
  if (at.getTime() > appt.getTime() - REMINDER_CUTOFF_MS) return keep("appointment_reminder", o, `No calling hours are left far enough before their appointment on ${when} for a reminder call.`);
  return { origin: o, journey: "appointment_reminder", verdict: due ? "call_now" : "scheduled", reason: `Appointment on ${when}${about}.`, callAt: at, priority: PLAN_JOURNEYS.appointment_reminder.priority, values };
}

/** A CRM's booking while their front desk has them booked: one reminder, from the front desk, which keeps the clinic's own diary. */
function byFrontDesk(o: Origin, b: PlanBooking, c: Ctx): Draft {
  const sys = systemOf(b);
  return keep("appointment_reminder", o, `Booked in ${sys} for ${whenText(b.startsAt, c)}: the reminder goes by ${sys}, the clinic's own system.`);
}

function noShowRow(r: PlanRecord, o: Origin, c: Ctx, again: (at: Date) => string | null): Draft {
  const crm = r.crm ?? "their CRM";
  const ref = r.appointmentAt ?? r.createdExt ?? null;
  if (!ref) return keep("no_show_rebook", o, `${crm} has no appointment or enquiry date for this record, so JENAI cannot tell how recent it is.`);
  const day = dayOf(ref, c.tz);
  const ago = Math.max(0, daysBetween(day, c.today));
  const what = r.appointmentAt ? `Missed their appointment on ${dateText(day)}` : `Marked "${r.status}" in ${crm}, enquiry from ${dateText(day)}`;
  if (ago > c.s.freshDays) return keep("no_show_rebook", o, `${r.appointmentAt ? "Missed their appointment" : "Enquired"} ${plural(ago, "day")} ago. ${coldCall(c.s.freshDays)}`);
  const since = again(ref);
  if (since) return keep("no_show_rebook", o, `${what}, but ${since}.`);
  return callable("no_show_rebook", o, c.now, `${what}.`, recordValues(r, c), c);
}

// ---------------------------------------------------------------- bookings at their front desk

const isBooked = (s: ClinicAppointmentStatus) => s === "booked" || s === "confirmed";
const systemOf = (x: { system?: string }) => x.system ?? "their front desk system";
/** Their front desk's cancellation on the day of `at`, if there is one. */
const cancelledOn = (bookings: readonly PlanBooking[], at: Date, c: Ctx) => bookings.find((b) => b.status === "cancelled" && dayOf(b.startsAt, c.tz) === dayOf(at, c.tz));

/**
 * From their front desk: a reminder for each day they are booked, and a call
 * to rebook their latest missed or cancelled booking. Several services
 * booked for one day are one visit to them, so one reminder, for the first.
 */
function bookingRows(bookings: readonly PlanBooking[], upcoming: readonly PlanBooking[], again: (at: Date) => string | null, c: Ctx): Draft[] {
  const rows: Draft[] = [];
  const days = new Map<string, PlanBooking[]>();
  for (const b of upcoming) {
    const day = dayOf(b.startsAt, c.tz);
    const list = days.get(day);
    if (list) list.push(b);
    else days.set(day, [b]);
  }
  for (const list of days.values()) {
    const first = list[0]!;
    const services = [...new Set(list.map((b) => b.service.trim()).filter(Boolean))];
    rows.push(reminderRow(first.startsAt, bookingOrigin(first), bookingValues(first, c), c, `${services.length ? ` for ${listText(services)}` : ""}, booked in ${systemOf(first)}`));
  }
  // Only the latest missed booking: one call to rebook answers any before it. On one day, a no-show before a cancellation.
  const missed = bookings
    .filter((b) => b.status === "no_show" || b.status === "cancelled")
    .sort((a, b) => dayOf(b.startsAt, c.tz).localeCompare(dayOf(a.startsAt, c.tz)) || Number(b.status === "no_show") - Number(a.status === "no_show") || a.startsAt.getTime() - b.startsAt.getTime())[0];
  const row = missed ? missedRow(missed, again, c) : null;
  if (row) rows.push(row);
  return rows;
}

/** A call to rebook a no-show or a cancellation, unless they have booked again or come in since. */
function missedRow(b: PlanBooking, again: (at: Date) => string | null, c: Ctx): Draft | null {
  const o = bookingOrigin(b);
  const noShow = b.status === "no_show";
  const journey: PlanJourney = noShow ? "no_show_rebook" : "cancelled_rebook";
  const day = dayOf(b.startsAt, c.tz);
  const ago = daysBetween(day, c.today);
  const service = b.service.trim() ? ` for ${b.service.trim()}` : "";
  const what = noShow ? `Missed their appointment on ${dateText(day)}${service}` : `Cancelled their appointment${service} booked for ${dateText(day)}`;
  const since = again(b.startsAt);
  // Long past and followed by another booking, a missed one is history, and not worth a row of its own.
  if (since) return ago <= c.s.freshDays ? keep(journey, o, `${what}, but ${since}.`) : null;
  if (ago > c.s.freshDays) return keep(journey, o, `${noShow ? "Missed their appointment" : "Their cancelled appointment was"} ${plural(ago, "day")} ago. ${coldCall(c.s.freshDays)}`);
  return callable(journey, o, c.now, `${what}.`, bookingValues(b, c), c);
}

/**
 * How they have moved on since missing a booking at `at` (or since now, for
 * one cancelled ahead of its day), in words, or null: a booking still to
 * come, at the front desk or in their CRM, first; else a visit on or after
 * that day; else a later booking whose outcome is not known.
 */
function bookedAgain(at: Date, records: readonly PlanRecord[], bookings: readonly PlanBooking[], visits: readonly VisitIn[], c: Ctx): string | null {
  const from = at < c.now ? at : c.now;
  const holding = (b: PlanBooking) => isBooked(b.status) || b.status === "checked_in";
  const ahead = [
    ...bookings.filter((b) => holding(b) && b.startsAt > c.now).map((b) => b.startsAt),
    // A CRM booking counts unless the front desk cancelled that day.
    ...records
      .filter((r) => r.appointmentAt && r.appointmentAt > c.now && ["booked", "customer"].includes(classOf(r.status, c.s)) && !cancelledOn(bookings, r.appointmentAt, c))
      .map((r) => r.appointmentAt!),
  ].sort((a, b) => a.getTime() - b.getTime())[0];
  if (ahead) return `is booked again for ${dateText(dayOf(ahead, c.tz))}`;
  const fromDay = dayOf(from, c.tz);
  const came = [...visits.filter((v) => v.day >= fromDay).map((v) => v.day), ...bookings.filter((b) => b.status === "completed" && b.startsAt > from).map((b) => dayOf(b.startsAt, c.tz))].sort().at(-1);
  if (came) return `came in on ${dateText(came)}`;
  const later = bookings
    .filter((b) => holding(b) && b.startsAt > from)
    .map((b) => b.startsAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return later ? `booked again for ${dateText(dayOf(later, c.tz))}` : null;
}

const BOOKING_STATUS_TEXT: Record<ClinicAppointmentStatus, string> = {
  booked: "still booked",
  confirmed: "confirmed",
  checked_in: "checked in",
  completed: "marked done",
  no_show: "marked a no-show",
  cancelled: "cancelled",
  unknown: "in a state JENAI does not know",
};

/** Someone whose bookings prompt no call still shows in the plan, by their latest booking. */
function lastBookingRow(bookings: readonly PlanBooking[], c: Ctx): Draft {
  const b = bookings.reduce((x, y) => (y.startsAt > x.startsAt ? y : x));
  const [o, sys, when] = [bookingOrigin(b), systemOf(b), whenText(b.startsAt, c)];
  if (isBooked(b.status) && b.startsAt <= c.now) return keep("appointment_unclear", o, `Their appointment on ${when} has passed and ${sys} still says booked, so JENAI cannot tell if they came. Update it in ${sys}.`);
  return keep("no_call", o, `Their latest booking in ${sys}, on ${when}, is ${BOOKING_STATUS_TEXT[b.status]}: no call about it is due.`);
}

function bookingOrigin(b: PlanBooking): Origin {
  return { type: "clinic_appointment", id: b.id, label: `${b.system ?? "Front desk"} booking`, name: b.name ?? null, centre: b.centre ?? null };
}

function bookingValues(b: PlanBooking, c: Ctx): Values {
  return {
    enquiry_about: b.service || null,
    treatment: b.service || null,
    branch: b.centre,
    doctor: b.doctor,
    appointment_date: dayOf(b.startsAt, c.tz),
    appointment_time: timeText(b.startsAt, c.tz),
  };
}

/**
 * After a visit: feedback, a check on how they are doing, then the next
 * session of a course or, once it is done, maintenance. Per service, from its
 * latest visit; feedback once per visit day however many services they had.
 * Their package for the service, when their front desk says, decides the
 * course: sessions left, done, on hold or ended.
 */
function visitRows(all: VisitIn[], c: Ctx): Draft[] {
  const groups = new Map<string, VisitIn[]>();
  for (const v of all) {
    const key = serviceKey(v.service);
    const g = groups.get(key);
    if (g) g.push(v);
    else groups.set(key, [v]);
  }
  const rows: Draft[] = [];
  const feedbackDays = new Set<string>();
  for (const [key, g] of groups) {
    g.sort((a, b) => a.day.localeCompare(b.day) || a.origin.id.localeCompare(b.origin.id));
    const last = g[g.length - 1]!;
    const rule = ruleFor(last.service, c.rules);
    const what = last.service || "their visit";
    const note = rule.isDefault ? " Timing is JENAI's default until the clinic's doctors confirm it." : "";
    const values: Values = { visit_date: last.day, last_visit: last.day, treatment: last.service || null, doctor: last.doctor, branch: last.branch };
    const after = (n: number) => startOf(addDays(last.day, n), c.tz);
    const every = rule.sessionIntervalDays;
    const maintenance = (had: string) => {
      const m = rule.maintenanceAfterDays;
      if (m) rows.push(callable("maintenance", last.origin, after(m), `${had} on ${dateText(last.day)}; maintenance is due every ${plural(m, "day")}.${note}`, values, c));
    };

    if (rule.feedbackAfterDays !== null && daysBetween(last.day, c.today) <= c.s.feedbackWithinDays && !feedbackDays.has(last.day)) {
      feedbackDays.add(last.day);
      rows.push(callable("visit_feedback", last.origin, after(rule.feedbackAfterDays), `Visited on ${dateText(last.day)}${last.service ? ` for ${last.service}` : ""}.`, values, c));
    }
    if (rule.resultCheckAfterDays !== null) {
      const due = addDays(last.day, rule.resultCheckAfterDays);
      if (daysBetween(due, c.today) <= c.s.resultCheckWithinDays)
        rows.push(
          callable("result_check", last.origin, startOf(due, c.tz), `Had ${what} on ${dateText(last.day)}; results usually show by about ${plural(rule.resultCheckAfterDays, "day")}.${note}`, { ...values, review_due: due }, c),
        );
    }

    const pkg = packageFor(key, last, c);
    if (pkg?.kind === "open") rows.push(openPackageRow(pkg, last, every, what, values, note, c));
    else if (pkg?.kind === "complete") maintenance(`Finished the course of ${what}`);
    else if (pkg?.kind === "frozen")
      rows.push(keep("next_session", last.origin, `Their package for ${what} is on hold in ${systemOf(pkg.p)}${pkg.left ? ` with ${plural(pkg.left, "session")} left` : ""}, so no call about the next session while it is.`));
    else if (pkg?.kind === "ended") {
      const p = pkg.p;
      const how = p.status === "cancelled" ? `was cancelled in ${systemOf(p)}` : p.expiresOn && p.expiresOn < c.today ? `ended on ${dateText(p.expiresOn)}` : `has expired in ${systemOf(p)}`;
      rows.push(keep("next_session", last.origin, `Their package for ${what} ${how}${pkg.left ? ` with ${plural(pkg.left, "session")} unused` : ""}, so there is no next session to call about.`));
    } else {
      const total = last.sessionsTotal ?? rule.courseSessions;
      const done = last.sessionsDone ?? g.length;
      if (total !== null && done < total) {
        if (every) rows.push(callable("next_session", last.origin, after(every), `Session ${done + 1} of ${total} of ${what} is due ${plural(every, "day")} after the last, on ${dateText(last.day)}.${note}`, values, c));
      } else if (rule.maintenanceAfterDays) {
        maintenance(total !== null ? `Finished the course of ${what}` : `Had ${what}`);
      } else if (total === null && every) {
        // Sessions with no set number (a drip, pigmentation): the next one, every interval.
        rows.push(callable("next_session", last.origin, after(every), `Had ${what} on ${dateText(last.day)}; sessions are due every ${plural(every, "day")}.${note}`, values, c));
      }
    }
  }
  return rows;
}

/** A service's name as visits and packages are matched on: any case, any spacing. */
const serviceKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

interface PackageState {
  /**
   * open: sessions left to book, on one in use or one bought and not yet
   * started; complete: none left; frozen: on hold; ended: expired or
   * cancelled with sessions unused.
   */
  kind: "open" | "complete" | "frozen" | "ended";
  p: PlanPackage;
  left: number | null;
}

/**
 * Which package speaks for a course when there are several: one being used,
 * then one bought and not yet started (a course bought again outranks the
 * one it replaces, used up), then one on hold, used up, ended.
 */
const packageRank = (st: PackageState) => (st.kind === "open" ? (st.p.status === "active" ? 0 : 1) : { frozen: 2, complete: 3, ended: 4 }[st.kind]);

/**
 * What one package says about a course. One in a state JENAI does not know,
 * or with no count of sessions left, says nothing: the treatment rule and
 * the visit's own counts decide. One that ended before their last visit
 * says nothing either: that visit was not from it.
 */
function packageState(p: PlanPackage, lastDay: string, today: string): PackageState | null {
  const left = p.balance ?? (p.total != null && p.used != null ? p.total - p.used : null);
  // Past its end date it is over, whatever status was last read.
  const ended = p.status === "cancelled" || p.status === "expired" || (!!p.expiresOn && p.expiresOn < today);
  if (left !== null && left <= 0 && p.status !== "cancelled") return { kind: "complete", p, left: 0 };
  if (ended) return p.expiresOn && p.expiresOn < lastDay ? null : { kind: "ended", p, left };
  if (p.status === "frozen") return { kind: "frozen", p, left };
  if ((p.status === "active" || p.status === "not_started") && left !== null) return { kind: "open", p, left };
  return null;
}

/**
 * Whether a package line pays for this visit's service: a service line by
 * its name, a category line by the service's category or sub-category. A
 * tag line never matches: JENAI does not know which services carry a tag.
 */
function covers(p: PlanPackage, key: string, v: VisitIn): boolean {
  const k = serviceKey(p.service);
  if (p.covers === "category") return v.categories.some((x) => serviceKey(x) === k);
  return p.covers !== "tag" && k === key;
}

/** Of their packages for a service, the one that speaks for the course: as packageRank says, then ending soonest. */
function packageFor(key: string, last: VisitIn, c: Ctx): PackageState | null {
  let best: PackageState | null = null;
  for (const p of c.packages) {
    if (!covers(p, key, last)) continue;
    const st = packageState(p, last.day, c.today);
    if (!st) continue;
    const ends = (x: PackageState) => x.p.expiresOn ?? "9999-12-31";
    if (!best || packageRank(st) < packageRank(best) || (packageRank(st) === packageRank(best) && ends(st) < ends(best))) best = st;
  }
  return best;
}

/**
 * The next session from a package with sessions left: at the usual gap after
 * the last, or now when the package ends within packageEndingWithinDays, so
 * they can use what they paid for before it does.
 */
function openPackageRow(pkg: PackageState, last: VisitIn, every: number | null, what: string, values: Values, note: string, c: Ctx): Draft {
  const { p } = pkg;
  const left = pkg.left!;
  const total = p.total ?? last.sessionsTotal;
  const done = p.used ?? (total !== null ? total - left : null);
  const session = total !== null && done !== null && done >= 0 && done < total ? `Session ${done + 1} of ${total} of ${what}` : `The next session of ${what}`;
  const ends = p.expiresOn ?? null;
  const theirs = p.status === "not_started" ? "the package they bought, not started yet" : "their package";
  if (ends && daysBetween(c.today, ends) <= c.s.packageEndingWithinDays)
    return callable("next_session", last.origin, c.now, `${plural(left, "session")} left, package ends on ${dateText(ends)}: called now so they can book before it does. ${session} is next; the last was on ${dateText(last.day)}.`, values, c);
  if (every)
    return callable(
      "next_session",
      last.origin,
      startOf(addDays(last.day, every), c.tz),
      `${session} is due ${plural(every, "day")} after the last, on ${dateText(last.day)}. ${plural(left, "session")} left on ${theirs}${ends ? `, which ends on ${dateText(ends)}` : ""}.${note}`,
      values,
      c,
    );
  return keep("next_session", last.origin, `${plural(left, "session")} of ${what} left on ${theirs}, but no gap between sessions is set for it, so JENAI cannot tell when the next is due. Add one in the treatment rules.`);
}

/**
 * A call that will be made: now when it is due, otherwise on its day; never
 * within minGapDays of the last call with them; always inside calling hours.
 */
function callable(journey: PlanJourney, o: Origin, due: Date, reason: string, values: Values, c: Ctx, opts: { priority?: number } = {}): Draft {
  let at = due > c.now ? due : c.now;
  let verdict: PlannedCallVerdict = due > c.now ? "scheduled" : "call_now";
  let moved = false;
  if (c.lastCallAt && c.s.minGapDays > 0) {
    const free = new Date(c.lastCallAt.getTime() + c.s.minGapDays * DAY_MS);
    if (free > at) [at, verdict, moved] = [free, "scheduled", true];
  }
  at = nextWindowStart(at, c.s.callingWindow, c.tz);
  if (moved)
    reason += ` Moved to ${dateText(dayOf(at, c.tz))}: the last call with them was on ${dateText(dayOf(c.lastCallAt!, c.tz))}, and calls are kept ${plural(c.s.minGapDays, "day")} apart.`;
  return { origin: o, journey, verdict, reason, callAt: at, priority: opts.priority ?? PLAN_JOURNEYS[journey].priority, values };
}

function keep(journey: PlanJourney, o: Origin, reason: string): Draft {
  return { origin: o, journey, verdict: "kept_out", reason, callAt: null, priority: 0, values: {} };
}

type StatusClass = "never" | "no_show" | "booked" | "customer" | "open" | "unknown";

/** A record with no status is an enquiry not yet worked. */
function classOf(status: string | null | undefined, s: PlanSettings): StatusClass {
  if (!statusOf(status)) return "open";
  const st = status!;
  if (inList(s.neverStatuses, st) || inList(s.doNotCallStatuses, st)) return "never";
  if (inList(s.noShowStatuses, st)) return "no_show";
  if (inList(s.bookedStatuses, st)) return "booked";
  if (inList(s.customerStatuses, st)) return "customer";
  if (inList(s.openStatuses, st)) return "open";
  return "unknown";
}

/** Words compared the way people type them: any case, spacing or punctuation. */
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const inList = (list: readonly string[], v: string) => list.some((x) => norm(x) === norm(v));
/** An empty pick list shows as "-None-" on Zoho's screens; treated as no status wherever it comes from. */
const statusOf = (s: string | null | undefined) => (norm(s) === "none" ? "" : norm(s));

function recordOrigin(r: PlanRecord): Origin {
  const one = r.module.endsWith("s") ? r.module.slice(0, -1) : r.module;
  return { type: "crm_record", id: r.id, label: `${r.crm ?? "CRM"} ${one}`, name: r.name ?? null, centre: r.centre ?? null };
}

function visitIn(v: PlanVisit): VisitIn {
  return {
    origin: { type: "visit", id: v.id, label: v.source && v.source !== "upload" ? "Visit record" : "Visit list", name: v.name ?? null, centre: v.branch ?? null },
    service: v.service,
    day: v.visitDate,
    doctor: v.doctor ?? null,
    branch: v.branch ?? null,
    sessionsDone: v.sessionsDone ?? null,
    sessionsTotal: v.sessionsTotal ?? null,
    categories: v.categories ?? [],
  };
}

function recordValues(r: PlanRecord, c: Ctx): Values {
  const appt = r.appointmentAt;
  return {
    enquiry_about: r.treatment,
    enquiry_date: r.createdExt ? dayOf(r.createdExt, c.tz) : null,
    enquiry_source: r.source,
    branch: r.centre,
    doctor: r.consultant,
    treatment: r.treatment,
    appointment_date: appt ? dayOf(appt, c.tz) : null,
    appointment_time: appt ? timeText(appt, c.tz) : null,
  };
}

/** Only the variables the program's script declares, and only those with a value. */
function contextOf(program: string, values: Values): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PROGRAM_VARIABLES[program] ?? []) {
    const v = values[k];
    if (v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- days, in the client's time zone

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The calendar day an instant falls on for the client, as yyyy-mm-dd. */
function dayOf(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
const ymd = (day: string) => day.split("-").map(Number) as [number, number, number];
function addDays(day: string, n: number): string {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** A wall-clock time on a day, for the client. */
function startOf(day: string, tz: string, minutes = 0): Date {
  const [y, m, d] = ymd(day);
  return zoned(y, m, d, minutes, tz);
}
/** "Mon 5 Oct 2026" */
function dateText(day: string): string {
  const [y, m, d] = ymd(day);
  return `${WEEKDAYS[weekday(day)]} ${d} ${MONTHS[m - 1]} ${y}`;
}
/** "10:30 AM", as the reminder script says it. */
function timeText(at: Date, tz: string): string {
  const { minutes } = localParts(at, tz);
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${pad(minutes % 60)} ${h < 12 ? "AM" : "PM"}`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Fri 2 Oct 2026 at 10:30 AM" */
const whenText = (at: Date, c: Ctx) => `${dateText(dayOf(at, c.tz))} at ${timeText(at, c.tz)}`;
/** "A, B and C" */
const listText = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------- one client

export interface ReplanResult {
  /** People planned: one per number, plus one per record with no usable number. */
  people: number;
  rows: number;
  /** Rows from an earlier plan that no longer apply, removed. */
  removed: number;
  byVerdict: Record<PlannedCallVerdict, number>;
  byJourney: Partial<Record<PlanJourney, Partial<Record<PlannedCallVerdict, number>>>>;
  /** Visits read from a connected system whose phone number has not been read yet: not planned until it is. */
  waitingForPhone: number;
  /**
   * People in this plan whose front desk profile says they agreed to
   * marketing SMS (and none of their profiles says no). For the clinic's
   * information only: no call is planned on it.
   */
  marketingConsent: number;
}

const CRM_NAMES: Record<string, string> = { zoho_crm: "Zoho", salesforce: "Salesforce", hubspot: "HubSpot", leadsquared: "LeadSquared", google_sheets: "their sheet", zenoti: "Zenoti" };
/** Rows per insert statement. */
const CHUNK = 500;

/**
 * Plans everyone in one client's records again and stores it in
 * planned_calls: rows that still apply are updated in place (same id),
 * rows for records, visits or calls that no longer apply are removed.
 * Reads crm_records (not deleted), visits, front desk bookings
 * (clinic_appointments), package balances and guests (external_people),
 * do-not-call entries, the last call with each number, plan settings and
 * treatment rules. A visit still waiting for its phone number is counted,
 * not planned; a booking or package with no number known is left out.
 *
 * A preview only: never creates campaign targets, never dials, never writes
 * to the client's CRM.
 */
export async function replanTenant(tenantId: string, opts: { now?: Date } = {}): Promise<ReplanResult> {
  const now = opts.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    // One plan at a time per client, so two runs cannot remove each other's rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`care-plan:${tenantId}`}, 0))`);
    const [org] = await tx.select({ timezone: organizations.timezone, vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, tenantId));
    const [own] = await tx.select({ settings: callPlanSettings.settings }).from(callPlanSettings).where(eq(callPlanSettings.tenantId, tenantId));
    const settings = planSettingsOf(own?.settings, org?.timezone ?? DEFAULT_PLAN_SETTINGS.timezone);
    const rules = treatmentRulesFor(await tx.select().from(treatmentRules), org?.vertical);
    const connections = await tx.select({ id: integrations.id, kind: integrations.kind, config: integrations.config }).from(integrations);
    const kindOf = new Map(connections.map((i) => [i.id, i.kind as string]));
    const systemNamed = (integrationId: string) => CRM_NAMES[kindOf.get(integrationId) ?? ""];
    // A centre is named as its JENAI branch, else as their system names it (config.centres), so the plan's centres treat bookings and visits alike.
    const branchName = new Map((await tx.select({ id: branches.id, name: branches.name }).from(branches)).map((b) => [b.id, b.name]));
    const centreName = new Map(
      connections.flatMap((i) =>
        (Array.isArray(i.config.centres) ? i.config.centres : []).flatMap((x) => {
          const c = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
          const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : typeof c.code === "string" && c.code.trim() ? c.code.trim() : null;
          return typeof c.id === "string" && name ? [[`${i.id}:${c.id}`, name] as const] : [];
        }),
      ),
    );
    const placeOf = (integrationId: string | null, branchId: string | null, centreRef: string | null, own: string | null) =>
      (branchId ? branchName.get(branchId) : undefined) ?? (integrationId && centreRef ? centreName.get(`${integrationId}:${centreRef}`) : undefined) ?? own;
    const records = await tx.select().from(crmRecords).where(isNull(crmRecords.deletedAt));
    const taken = await tx.select().from(visits);
    const guests = await tx
      .select({ integrationId: externalPeople.integrationId, ref: externalPeople.externalId, phone: externalPeople.phoneE164, marketing: externalPeople.marketingSmsConsent })
      .from(externalPeople);
    const booked = await tx
      .select({
        id: clinicAppointments.id,
        integrationId: clinicAppointments.integrationId,
        guestRef: clinicAppointments.guestRef,
        phone: clinicAppointments.phoneE164,
        name: clinicAppointments.name,
        service: clinicAppointments.service,
        startsAt: clinicAppointments.startsAt,
        status: clinicAppointments.status,
        doctor: clinicAppointments.doctor,
        branchId: clinicAppointments.branchId,
        centreRef: clinicAppointments.centreRef,
      })
      .from(clinicAppointments);
    const held = await tx.select().from(packageBalances);
    const blocked = await tx
      .select({ phone: suppressions.phoneE164, reason: suppressions.reason, expiresAt: suppressions.expiresAt })
      .from(suppressions)
      .where(or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, now)));
    const who = sql<string>`case when ${calls.direction} = 'inbound' then ${calls.fromE164} else ${calls.toE164} end`;
    const lastCalls = await tx
      .select({ phone: who, at: sql<Date>`max(${calls.startedAt})`.mapWith(calls.startedAt) })
      .from(calls)
      .groupBy(who);
    const programs = new Set((await tx.selectDistinct({ key: clientPrograms.programKey }).from(clientPrograms)).map((p) => p.key));
    const contactOf = new Map((await tx.select({ id: contacts.id, phone: contacts.phoneE164 }).from(contacts)).map((x) => [x.phone, x.id]));

    // One person per number. A record whose number could not be read stands alone.
    const people = new Map<string, PlanPerson>();
    const personFor = (key: string, phone: string | null) => {
      let p = people.get(key);
      if (!p) people.set(key, (p = { phone, records: [], visits: [], bookings: [], packages: [], suppressions: [], lastCallAt: null, contactId: phone ? (contactOf.get(phone) ?? null) : null, programs }));
      return p;
    };
    for (const r of records) personFor(r.phoneE164 ?? `record:${r.id}`, r.phoneE164).records.push({ ...r, crm: systemNamed(r.integrationId) ?? "their CRM" });
    // A booking, package or visit carries the number known when it was read; their guest record may know it since.
    const guestPhone = new Map(guests.filter((g) => g.phone).map((g) => [`${g.integrationId}:${g.ref}`, g.phone!]));
    const phoneOf = (x: { integrationId: string | null; guestRef: string | null; phone?: string | null; phoneE164?: string | null }) =>
      x.phone ?? x.phoneE164 ?? (x.integrationId && x.guestRef ? guestPhone.get(`${x.integrationId}:${x.guestRef}`) : undefined) ?? null;
    const visitOf = (v: (typeof taken)[number], phone: string): PlanVisit => ({ ...v, phoneE164: phone, branch: placeOf(v.integrationId, v.branchId, v.centreRef, v.branch) });
    for (const v of taken) {
      if (!v.phoneE164) continue;
      const p = personFor(v.phoneE164, v.phoneE164);
      p.visits.push(visitOf(v, v.phoneE164));
      p.contactId ??= v.contactId;
    }
    // A visit read from their system before its number takes their guest's
    // number once that is known, unless it is a copy of a visit they already
    // have that day; with none known it is counted, and planned once one arrives.
    let waitingForPhone = 0;
    for (const v of taken) {
      if (v.phoneE164) continue;
      const phone = phoneOf(v);
      if (!phone) {
        waitingForPhone++;
        continue;
      }
      const p = personFor(phone, phone);
      if (p.visits.some((x) => x.visitDate === v.visitDate && serviceKey(x.service) === serviceKey(v.service))) continue;
      p.visits.push(visitOf(v, phone));
    }
    for (const b of booked) {
      const phone = phoneOf(b);
      if (phone) personFor(phone, phone).bookings!.push({ ...b, centre: placeOf(b.integrationId, b.branchId, b.centreRef, null), system: systemNamed(b.integrationId) });
    }
    // A package alone prompts no call: it only tells the calls about visits and bookings how the course stands.
    for (const k of held) {
      const phone = phoneOf(k);
      if (phone) people.get(phone)?.packages!.push({ ...k, system: systemNamed(k.integrationId) });
    }
    for (const b of blocked) people.get(b.phone)?.suppressions!.push({ reason: b.reason, expiresAt: b.expiresAt });
    for (const l of lastCalls) {
      const p = l.phone ? people.get(l.phone) : undefined;
      if (p && l.at) p.lastCallAt = l.at;
    }

    const rows = new Map<string, PlanRow>();
    for (const p of people.values()) for (const row of planPerson(p, settings, rules, now)) rows.set(`${row.originType}:${row.originId}:${row.journey}`, row);
    const list = [...rows.values()];

    for (let n = 0; n < list.length; n += CHUNK) {
      await tx
        .insert(plannedCalls)
        .values(list.slice(n, n + CHUNK).map((r) => ({ tenantId, ...r })))
        .onConflictDoUpdate({
          target: [plannedCalls.tenantId, plannedCalls.originType, plannedCalls.originId, plannedCalls.journey],
          set: {
            contactId: sql`excluded.contact_id`,
            phoneE164: sql`excluded.phone_e164`,
            name: sql`excluded.name`,
            programKey: sql`excluded.program_key`,
            verdict: sql`excluded.verdict`,
            reason: sql`excluded.reason`,
            callAt: sql`excluded.call_at`,
            priority: sql`excluded.priority`,
            originLabel: sql`excluded.origin_label`,
            context: sql`excluded.context`,
            computedAt: sql`now()`,
          },
        });
    }
    const removed = await tx
      .delete(plannedCalls)
      .where(
        and(
          eq(plannedCalls.tenantId, tenantId),
          sql`(${plannedCalls.originType} || ':' || ${plannedCalls.originId}::text || ':' || ${plannedCalls.journey}) not in (select jsonb_array_elements_text(${JSON.stringify([...rows.keys()])}::jsonb))`,
        ),
      )
      .returning({ id: plannedCalls.id });

    const byVerdict: Record<PlannedCallVerdict, number> = { call_now: 0, scheduled: 0, waiting: 0, kept_out: 0 };
    const byJourney: ReplanResult["byJourney"] = {};
    for (const r of list) {
      byVerdict[r.verdict]++;
      const j = (byJourney[r.journey] ??= {});
      j[r.verdict] = (j[r.verdict] ?? 0) + 1;
    }
    // Agreed only when every profile with the number that says anything says yes.
    const agreed = new Map<string, boolean>();
    for (const g of guests) if (g.phone && g.marketing !== null) agreed.set(g.phone, (agreed.get(g.phone) ?? true) && g.marketing);
    const marketingConsent = [...people.keys()].filter((k) => agreed.get(k) === true).length;
    return { people: people.size, rows: list.length, removed: removed.length, byVerdict, byJourney, waitingForPhone, marketingConsent };
  });
}
