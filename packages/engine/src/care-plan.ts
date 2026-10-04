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
import { and, eq, gt, isNull, lte, notInArray, or, sql } from "drizzle-orm";
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
  type Tx,
} from "@jenai/db";
import { suppressionStops, type Purpose } from "./dialer/policy";
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
/** A client's plan is worked out again at least this often, as the days move calls from scheduled to due. */
export const REPLAN_EVERY_MINUTES = 60;

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
  course_checkin: { program: "clinic.course_checkin", label: "Check in and book their next sitting", priority: 65 },
  visit_feedback: { program: "clinic.feedback", label: "Ask how their visit went", priority: 60 },
  callback_due: { program: "clinic.warm_followup", label: "Call back on the date the team noted", priority: 50 },
  new_enquiry: { program: "clinic.warm_followup", label: "Call to book a consultation", priority: 40 },
  no_show_rebook: { program: "clinic.warm_followup", label: "They missed their appointment: call to rebook", priority: 30 },
  cancelled_rebook: { program: "clinic.warm_followup", label: "They cancelled: call to rebook", priority: 25 },
  maintenance: { program: "clinic.revisit_recall", label: "Book their maintenance session", priority: 10 },
  appointment_unclear: { program: "", label: "Appointment outcome unknown", priority: 0 },
  no_call: { program: "", label: "No call", priority: 0 },
} as const;
export type PlanJourney = keyof typeof PLAN_JOURNEYS;

/** Priority given to a new enquiry made within the last day: above every other enquiry call. */
const FRESH_ENQUIRY_PRIORITY = 55;

/** Calls whose point is to get them booked: an appointment already coming up makes them wait. */
const BOOKING_JOURNEYS = new Set<PlanJourney>(["callback_due", "new_enquiry", "no_show_rebook", "cancelled_rebook", "course_checkin", "maintenance"]);
/**
 * Calls about an enquiry or a booking they let go, as against care after a
 * visit: only for someone who asked the clinic first and has not said no since.
 */
const ENQUIRY_JOURNEYS = new Set<PlanJourney>(["callback_due", "new_enquiry", "no_show_rebook", "cancelled_rebook"]);

/** The variables each program's script fills in (packages/db/seed-data/programs); program-files.test.ts keeps the two in line. */
export const PROGRAM_VARIABLES: Record<string, readonly string[]> = {
  "clinic.warm_followup": ["caller_name", "enquiry_about", "enquiry_date", "enquiry_source", "branch"],
  "clinic.appointment_reminder": ["caller_name", "appointment_date", "appointment_time", "doctor", "branch"],
  "clinic.prescription_followup": ["caller_name", "visit_date", "treatment", "doctor", "review_due"],
  "clinic.feedback": ["caller_name", "visit_date", "doctor", "branch"],
  "clinic.revisit_recall": ["caller_name", "treatment", "last_visit", "doctor"],
  "clinic.course_checkin": ["caller_name", "treatment", "last_visit", "sitting_number", "sessions_left", "next_due", "doctor", "branch"],
};

/**
 * The purpose of each program's calls (packages/db/seed-data/programs), as
 * the dialer's policy reads it. None of them is promotional.
 */
export const PROGRAM_PURPOSE: Record<string, Purpose> = {
  "clinic.appointment_reminder": "transactional",
  "clinic.prescription_followup": "service",
  "clinic.feedback": "service",
  "clinic.warm_followup": "service",
  "clinic.revisit_recall": "service",
  "clinic.course_checkin": "service",
};
/** The purpose a row's calls would have; a row that is never called counts as service. */
export const purposeOf = (programKey: string): Purpose => PROGRAM_PURPOSE[programKey] ?? "service";

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
  /** The person said no: no call to book them about an enquiry made before this record changed. */
  declinedStatuses: string[];
  /** The person, not only this record, is not to be called. */
  doNotCallStatuses: string[];
  /** Lead sources that are the clinic's own outreach (bought or imported lists, cold calls): not an enquiry the person made. */
  outboundSources: string[];
  /** When set, only these lead sources count as an enquiry the person made. Empty: any source not in outboundSources. */
  enquirySources: string[];
  /** Centres this plan covers. Empty: all. */
  centres: string[];
  /** No planned call within this many days of the person's last call. */
  minGapDays: number;
  /** Hour of the evening before an appointment the reminder is made, local time; kept inside the calling window. */
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
  /** A course check-in or maintenance call is made only this many days past its due date: later, it is a win-back offer. */
  recallWithinDays: number;
  /** A package with sessions left that ends within this many days is called about by then, not at the usual gap. */
  packageEndingWithinDays: number;
  /** The one call between sittings of a course goes this many days before the next sitting is due. */
  checkinLeadDays: number;
  /** A break between sittings longer than this, or than 2.5 times the treatment's gap between sittings when that is longer, starts a new course. */
  courseGapDays: number;
  /** At most this many calls to one person in any 30 days: a later call waits until the 30 days allow it. */
  maxCallsPer30Days: number;
  /** The client's time zone, from their organisation. Not a setting they edit here. */
  timezone: string;
}

/**
 * Defaults for any client. The status words cover Zoho's standard Lead
 * Status values and the wording first seen at a skin clinic; a client whose
 * CRM words them differently maps their own on the plan settings page.
 */
export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  freshDays: 30,
  openStatuses: ["New Lead", "Interested", "Not Answered", "Follow-up", "Not Contacted", "Attempted to Contact", "Contacted", "Contact in Future", "Pre-Qualified"],
  bookedStatuses: ["Appointment Booked"],
  noShowStatuses: ["No Show"],
  customerStatuses: ["Converted", "Existing Client"],
  neverStatuses: ["Junk Lead", "Not Interested", "Invalid", "Do Not Call", "Lost Lead", "Not Qualified"],
  declinedStatuses: ["Not Interested", "Lost Lead"],
  doNotCallStatuses: ["Do Not Call"],
  // Zoho's own Lead Source values for leads a team finds itself, and the usual words for a bought or imported list.
  outboundSources: ["Cold Call", "Web Research", "Purchased List", "Bought List", "Imported List", "Import", "Data Purchase", "Cold Calling"],
  enquirySources: [],
  centres: [],
  minGapDays: 3,
  reminderHour: 18,
  callingWindow: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" },
  contactOnlyModules: ["Contacts"],
  consultationWithinDays: 60,
  checkInAfterDays: 3,
  feedbackWithinDays: 14,
  resultCheckWithinDays: 30,
  recallWithinDays: 60,
  packageEndingWithinDays: 30,
  checkinLeadDays: 3,
  courseGapDays: 60,
  maxCallsPer30Days: 3,
  timezone: "Asia/Kolkata",
};

/** The plan's settings that are a whole number of days, hours or calls. */
export type PlanNumberKey = NumberKey;
type NumberKey =
  | "freshDays"
  | "minGapDays"
  | "reminderHour"
  | "consultationWithinDays"
  | "checkInAfterDays"
  | "feedbackWithinDays"
  | "resultCheckWithinDays"
  | "recallWithinDays"
  | "packageEndingWithinDays"
  | "checkinLeadDays"
  | "courseGapDays"
  | "maxCallsPer30Days";
type ListKey =
  | "openStatuses"
  | "bookedStatuses"
  | "noShowStatuses"
  | "customerStatuses"
  | "neverStatuses"
  | "declinedStatuses"
  | "doNotCallStatuses"
  | "outboundSources"
  | "enquirySources"
  | "centres"
  | "contactOnlyModules";
const NUMBER_LIMITS: Record<NumberKey, readonly [number, number]> = {
  freshDays: [1, 365],
  minGapDays: [0, 60],
  reminderHour: [0, 23],
  consultationWithinDays: [1, 365],
  checkInAfterDays: [0, 60],
  feedbackWithinDays: [1, 90],
  resultCheckWithinDays: [1, 180],
  recallWithinDays: [1, 365],
  packageEndingWithinDays: [0, 180],
  checkinLeadDays: [0, 30],
  courseGapDays: [14, 730],
  maxCallsPer30Days: [1, 30],
};
const LIST_KEYS: ListKey[] = [
  "openStatuses",
  "bookedStatuses",
  "noShowStatuses",
  "customerStatuses",
  "neverStatuses",
  "declinedStatuses",
  "doNotCallStatuses",
  "outboundSources",
  "enquirySources",
  "centres",
  "contactOnlyModules",
];
/** The smallest and largest value each number setting takes. */
export const PLAN_NUMBER_LIMITS: Readonly<Record<PlanNumberKey, readonly [number, number]>> = NUMBER_LIMITS;
/** The status lists, in the order a status is looked for in them. */
export const STATUS_LISTS = ["doNotCallStatuses", "declinedStatuses", "neverStatuses", "noShowStatuses", "bookedStatuses", "customerStatuses", "openStatuses"] as const;
export type StatusList = (typeof STATUS_LISTS)[number];

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

/** The settings a client can change here. The time zone is not one: it is their organisation's. */
export const PLAN_SETTING_KEYS = [...(Object.keys(NUMBER_LIMITS) as NumberKey[]), ...LIST_KEYS, "callingWindow" as const];
export type PlanSettingKey = NumberKey | ListKey | "callingWindow";

/**
 * Why a value cannot be stored as this setting, in plain words, or null when
 * it can. planSettingsOf() quietly keeps the default for a value it cannot
 * use, so whoever sets one is told here instead.
 */
export function planSettingProblem(key: PlanSettingKey, value: unknown): string | null {
  if (key === "callingWindow") {
    const days = (value as { days?: unknown } | null)?.days;
    const ok = Array.isArray(days) && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && windowOf(value);
    return ok ? null : `callingWindow must look like {"days": [1, 2, 3, 4, 5, 6], "start": "10:00", "end": "19:00"}, where day 0 is Sunday, and leave some calling time between 09:00 and 21:00.`;
  }
  if ((LIST_KEYS as string[]).includes(key)) {
    return Array.isArray(value) && value.every((x) => typeof x === "string" && x.trim()) ? null : `${key} must be a list of names in quotes, such as ["First", "Second"], or [] for none.`;
  }
  const [min, max] = NUMBER_LIMITS[key as NumberKey];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? null : `${key} must be a whole number from ${min} to ${max}.`;
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
  /** When it last changed in their system. */
  modifiedExt?: Date | null;
  appointmentAt?: Date | null;
  /** False when their field held a date only. Left out or null: the time is taken as said. */
  appointmentHasTime?: boolean | null;
  followUpAt?: Date | null;
  /** Their notes say not to call this person. */
  notesSayDoNotCall?: boolean | null;
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
  /** The name and code of the clinic's branch the visit's branch was matched to, when it was. */
  branchKnownAs?: string[];
  sessionsDone?: number | null;
  sessionsTotal?: number | null;
  source?: string;
  /** The service's category and sub-category in their system, for a package that covers a whole category. */
  categories?: string[] | null;
  /** The connected system it was read from, as the clinic knows it ("Zenoti"); left out for an uploaded visit. */
  system?: string;
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
  /** Every other name that centre goes by (the JENAI branch's name and code, their system's own name), for the centres the plan covers. */
  centreKnownAs?: string[];
  /** When JENAI last saw it change: a cancellation ahead of its day fell due then, and keeps that time from one plan to the next. */
  changedAt?: Date | null;
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
  /** Live do-not-call entries for the number, the client's and the platform's. A scope limits one to calls of that purpose. */
  suppressions?: Array<{ reason: SuppressionReason; scope?: Purpose | null; expiresAt?: Date | null }>;
  /** Their last call with this client, either way. */
  lastCallAt?: Date | null;
  /** Calls made to them in the last 30 days, for the cap on calls in any 30 days. */
  recentCalls?: Date[];
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
  /**
   * When the call falls due, inside calling hours: for a call due now, the
   * first calling moment after it fell due, which stays the same from one plan
   * to the next. Null for someone kept out.
   */
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

/**
 * Of a number's live do-not-call entries, the one that stops a call made for
 * this purpose, by the dialer's own rule (dialer/policy suppressionStops), or
 * null. The DND register stops only promotional calls, which the plan never
 * makes.
 */
export function suppressionFor(
  entries: ReadonlyArray<{ reason: SuppressionReason; scope?: Purpose | null; expiresAt?: Date | null }>,
  purpose: Purpose,
  now: Date,
): SuppressionReason | null {
  return SUPPRESSION_ORDER.find((reason) => entries.some((x) => x.reason === reason && suppressionStops({ reason: x.reason, scope: x.scope ?? null, expiresAt: x.expiresAt ?? null }, purpose, now))) ?? null;
}
export const suppressionText = (r: SuppressionReason) => SUPPRESSION_TEXT[r];

type Values = Record<string, string | null | undefined>;

interface Origin {
  type: PlanOriginType;
  id: string;
  label: string;
  name: string | null;
  /** The centre as their records name it, for the clinic to read. */
  centre: string | null;
  /** Every name the centre goes by: their text, and the branch it was matched to. */
  centreNames: string[];
  /** For a CRM record: its lead source and when it was made. For a front desk booking: when it was for. */
  source: string | null;
  enquiredAt: Date | null;
  crm: string;
}

interface Draft {
  origin: Origin;
  journey: PlanJourney;
  verdict: PlannedCallVerdict;
  reason: string;
  callAt: Date | null;
  priority: number;
  values: Values;
  /** Said before "Another call to this person comes first" when the call waits, so the clinic still sees what it is about. */
  lead?: string;
}

interface Ctx {
  s: PlanSettings;
  rules: readonly PlanRule[];
  now: Date;
  tz: string;
  today: string;
  lastCallAt: Date | null;
  /** Calls made to them in the last 30 days, latest first. */
  recentCalls: Date[];
  personName: string | null;
  /** Days they came, oldest first: the visit list, and customers' appointments that have passed. */
  came: string[];
  /** Their front desk bookings, soonest first. */
  bookings: readonly PlanBooking[];
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

/** Records oldest first, so the same person comes out the same whatever order the database hands them in. */
const byRecord = (a: PlanRecord, b: PlanRecord) => (a.createdExt?.getTime() ?? Infinity) - (b.createdExt?.getTime() ?? Infinity) || a.id.localeCompare(b.id);
const byVisit = (a: PlanVisit, b: PlanVisit) => a.visitDate.localeCompare(b.visitDate) || a.service.toLowerCase().localeCompare(b.service.toLowerCase()) || a.id.localeCompare(b.id);
const byBooking = (a: PlanBooking, b: PlanBooking) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id);
const packageOrder = (p: PlanPackage) => [serviceKey(p.service), p.covers ?? "service", p.expiresOn ?? "", p.status, p.total ?? -1, p.used ?? -1, p.balance ?? -1].join("\u0000");
const byPackage = (a: PlanPackage, b: PlanPackage) => packageOrder(a).localeCompare(packageOrder(b));

/**
 * Every call the plan would make to one person, one row per thing that
 * prompts a call and kind of call, with when and why, or why not. Pure, and
 * the same rows for the same person whatever order their records come in.
 *
 * At most one row comes out call_now or scheduled: the call that comes first.
 * The others wait for it. Do-not-call overrides everything.
 */
export function planPerson(person: PlanPerson, settings: PlanSettings, rules: readonly PlanRule[], now: Date): PlanRow[] {
  const tz = settings.timezone;
  const records = [...person.records].sort(byRecord);
  const visitList = [...person.visits].sort(byVisit);
  const bookings = [...(person.bookings ?? [])].sort(byBooking);
  const c: Ctx = {
    s: settings,
    rules,
    now,
    tz,
    today: dayOf(now, tz),
    lastCallAt: person.lastCallAt ?? null,
    recentCalls: [...(person.recentCalls ?? [])].sort((a, b) => b.getTime() - a.getTime()),
    personName: records.find((r) => r.name)?.name ?? visitList.find((v) => v.name)?.name ?? bookings.find((b) => b.name)?.name ?? null,
    came: [],
    bookings,
    packages: [...(person.packages ?? [])].sort(byPackage),
  };
  const drafts: Draft[] = [];
  const uploaded = visitList.filter((v) => v.visitDate <= c.today).map((v) => visitIn(v));
  const uploadedDays = new Set(uploaded.map((v) => v.day));
  const isContactOnly = (r: PlanRecord) => contactOnly(r, settings);
  const hasEnquiry = records.some((r) => !isContactOnly(r));
  // Their front desk system is the clinic's own record of bookings: a reminder goes by it before any CRM's.
  const upcoming = bookings.filter((b) => isBooked(b.status) && b.startsAt > now);
  const frontDesk = upcoming[0];

  // A customer's appointment that has passed is their visit, unless the visit list already has that day.
  const derived: VisitIn[] = [];
  for (const r of records) {
    if (isContactOnly(r) || classOf(r.status, settings) !== "customer" || !r.appointmentAt || !passed(r, c)) continue;
    const day = dayOf(r.appointmentAt, tz);
    if (!uploadedDays.has(day))
      derived.push({ origin: recordOrigin(r), service: r.treatment ?? "", day, doctor: r.consultant ?? null, branch: r.centre ?? null, sessionsDone: null, sessionsTotal: null, categories: [] });
  }
  const all = [...uploaded, ...derived];
  c.came = [...new Set(all.map((v) => v.day))].sort();

  // A CRM booking whose date has passed is answered by a visit on or after it, a no-show at the front desk on or after it, or a cancellation there that day.
  const answered = (appt: Date) => {
    const day = dayOf(appt, tz);
    if (c.came.some((d) => d >= day)) return true;
    return bookings.some((b) => {
      const d = dayOf(b.startsAt, tz);
      return ((b.status === "completed" || b.status === "no_show") && d >= day) || (b.status === "cancelled" && d === day);
    });
  };
  // A CRM appointment still to come: the front desk's own booking, or its cancellation that day, speaks for it.
  const crmReminder = (r: PlanRecord, o: Origin) => {
    if (frontDesk) return byFrontDesk(o, frontDesk, c);
    const off = cancelledOn(bookings, r.appointmentAt!, c);
    if (off) return keep("appointment_reminder", o, `Cancelled in ${systemOf(off)} for ${whenText(off.startsAt, c)}: no reminder, as ${systemOf(off)} is the clinic's own system.`);
    return reminderRow(r.appointmentAt!, r.appointmentHasTime !== false, o, recordValues(r, c), c);
  };
  const again = (at: Date) => bookedAgain(at, records, bookings, all, c);

  for (const r of records) {
    const o = recordOrigin(r);
    if (isContactOnly(r)) {
      if (!hasEnquiry && !uploaded.length && !bookings.length) drafts.push(keep("no_call", o, `Only in ${o.crm} ${r.module}: no enquiry or visit on record.`));
      continue;
    }
    const cls = classOf(r.status, settings);
    if (cls === "never") {
      drafts.push(keep("no_call", o, `Marked "${r.status}" in ${o.crm}.`));
      continue;
    }
    if (cls === "unknown") {
      drafts.push(keep("no_call", o, `"${r.status}" is not a status the plan settings know, so JENAI cannot tell which call fits. Add it to one of the status lists.`));
      continue;
    }
    // An appointment still to come is reminded, whatever the status says: a
    // CRM's status often lags behind its appointment field. The front desk's
    // own booking or cancellation speaks for it first.
    if (r.appointmentAt && !passed(r, c)) {
      drafts.push(crmReminder(r, o));
      continue;
    }
    switch (cls) {
      case "open":
        drafts.push(...enquiryRows(r, o, c));
        break;
      case "booked":
        // Still booked in their CRM, but the visit list or the front desk shows what happened: that speaks for it.
        if (!(r.appointmentAt && answered(r.appointmentAt))) drafts.push(bookedRow(r, o, c, crmReminder));
        break;
      case "no_show":
        drafts.push(noShowRow(r, o, c, again));
        break;
      case "customer":
        if (!r.appointmentAt && !uploaded.length) drafts.push(keep("no_call", o, `${o.crm} has no visit date for this patient. Upload the visit list so JENAI knows what they had and when.`));
        break;
    }
  }

  // A sitting of a course already booked, at the front desk or in their CRM: its reminder is the call before it.
  const bookedFor = (key: string): string | null => {
    const desk = upcoming.find((b) => b.service.trim() && treatmentKey(b.service, rules) === key);
    if (desk) return `Their next sitting is already booked in ${systemOf(desk)} for ${whenText(desk.startsAt, c)}`;
    const crm = records
      .filter((r) => r.treatment?.trim() && r.appointmentAt && !passed(r, c) && !isContactOnly(r) && !["never", "unknown"].includes(classOf(r.status, settings)))
      .filter((r) => !cancelledOn(bookings, r.appointmentAt!, c) && treatmentKey(r.treatment!, rules) === key)
      .sort((a, b) => a.appointmentAt!.getTime() - b.appointmentAt!.getTime())[0];
    if (crm) return `Their next sitting is already booked in ${crm.crm ?? "their CRM"} for ${crm.appointmentHasTime === false ? dateText(dayOf(crm.appointmentAt!, tz)) : whenText(crm.appointmentAt!, c)}`;
    return null;
  };

  drafts.push(...bookingRows(bookings, upcoming, again, c));
  drafts.push(...visitRows(all, c, bookedFor));
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
    for (const d of drafts) if (live(d) && d.origin.centre && !covered(settings.centres, d.origin.centreNames)) out(d, `For the ${d.origin.centre} centre, which this plan does not cover.`);
  if (!person.phone) for (const d of drafts) if (live(d)) out(d, "No phone number JENAI can dial.");
  // An enquiry call is a service call only when they asked the clinic first.
  for (const d of drafts) {
    if (!live(d) || !ENQUIRY_JOURNEYS.has(d.journey)) continue;
    const why = notAnEnquiry(d.origin.source, settings);
    if (why) out(d, why);
  }
  // Said no on another enquiry since this one was made: no more calls to book them about it.
  const declined = records
    .filter((r) => r.status && inList(settings.declinedStatuses, r.status))
    .map((r) => ({ r, at: r.modifiedExt ?? r.createdExt ?? null }))
    .reduce<{ r: PlanRecord; at: Date | null } | null>((a, b) => (!a || (b.at && (!a.at || b.at > a.at)) ? b : a), null);
  if (declined)
    for (const d of drafts) {
      if (!live(d) || !ENQUIRY_JOURNEYS.has(d.journey) || d.origin.id === declined.r.id) continue;
      if (!d.origin.enquiredAt || !declined.at || d.origin.enquiredAt <= declined.at)
        out(d, `Marked "${declined.r.status}" in ${declined.r.crm ?? "their CRM"} on another enquiry${declined.at ? ` (${dateText(dayOf(declined.at, tz))})` : ""}, so JENAI does not call to book them.`);
    }
  const dnc = records.find((r) => r.status && inList(settings.doNotCallStatuses, r.status));
  if (dnc) for (const d of drafts) out(d, `Marked "${dnc.status}" in ${dnc.crm ?? "their CRM"}.`);
  else {
    const noted = records.find((r) => r.notesSayDoNotCall);
    if (noted) for (const d of drafts) out(d, `The notes on their ${noted.crm ?? "CRM"} record say not to call them.`);
  }
  for (const d of drafts) {
    const stop = suppressionFor(person.suppressions ?? [], purposeOf(PLAN_JOURNEYS[d.journey].program), now);
    if (stop) out(d, SUPPRESSION_TEXT[stop]);
  }

  // One call at a time. With an appointment coming up, calls to get them booked wait for it.
  // Otherwise the call that comes first goes ahead: of those due now, the highest priority.
  const active = drafts.filter(live);
  const reminder = active.find((d) => d.journey === "appointment_reminder");
  const contenders = reminder ? active.filter((d) => !BOOKING_JOURNEYS.has(d.journey)) : active;
  const rank = (j: PlanJourney) => Object.keys(PLAN_JOURNEYS).indexOf(j);
  // Every call already due counts as due now: among those, the kind of call decides, not which fell due first.
  const goes = (d: Draft) => Math.max(d.callAt!.getTime(), now.getTime());
  const first = [...contenders].sort((a, b) => goes(a) - goes(b) || rank(a.journey) - rank(b.journey) || a.origin.id.localeCompare(b.origin.id))[0];
  for (const d of active) {
    if (d === first) continue;
    const ahead = reminder && BOOKING_JOURNEYS.has(d.journey) ? reminder : first!;
    Object.assign(d, { verdict: "waiting" as const, reason: `${d.lead ? `${d.lead} ` : ""}Another call to this person comes first: ${PLAN_JOURNEYS[ahead.journey].label}` });
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

/** Why a lead with this source is not an enquiry the person made, or null when it is. An empty source counts as an enquiry. */
function notAnEnquiry(source: string | null, s: PlanSettings): string | null {
  if (!source || !statusOf(source)) return null;
  if (inList(s.outboundSources, source)) return `Not an enquiry they made (lead source "${source}"): a call to them needs a 140-series number and promotional consent.`;
  if (s.enquirySources.length && !inList(s.enquirySources, source))
    return `Lead source "${source}" is not one the plan settings count as an enquiry they made, so JENAI does not call them about it. Add it to the enquiry sources if they asked the clinic first.`;
  return null;
}

/** The latest day they came on or after this one; with no day, within the fresh limit. */
function cameSince(day: string | null, c: Ctx): string | null {
  const from = day ?? addDays(c.today, -c.s.freshDays);
  return c.came.filter((d) => d >= from).at(-1) ?? null;
}

/**
 * Their latest front desk booking on or after this day (with no day, within
 * the fresh limit) whose time has come: checked in, done, missed, cancelled,
 * or passed and still booked. One still to come is left to the reminder, and
 * one in a state JENAI does not know says nothing.
 */
function deskSince(day: string | null, c: Ctx): PlanBooking | null {
  const from = day ?? addDays(c.today, -c.s.freshDays);
  const come = (b: PlanBooking) => b.status !== "unknown" && (!isBooked(b.status) || b.startsAt <= c.now);
  return c.bookings.filter((b) => come(b) && dayOf(b.startsAt, c.tz) >= from).at(-1) ?? null;
}

/** An open enquiry: a check-in after their consultation, the callback the team noted, or the first call. */
function enquiryRows(r: PlanRecord, o: Origin, c: Ctx): Draft[] {
  const crm = o.crm;
  const F = c.s.freshDays;
  const values = recordValues(r, c);
  const created = r.createdExt ? dayOf(r.createdExt, c.tz) : null;
  const appt = r.appointmentAt;
  // A recent consultation on this record: a check-in about it, never a call to book one.
  if (appt && (r.consultant || /consult/i.test(r.treatment ?? ""))) {
    const day = dayOf(appt, c.tz);
    if (daysBetween(day, c.today) <= c.s.consultationWithinDays) {
      const still = r.status ? `still marked "${r.status}"` : "still an open enquiry";
      return [
        callable("after_consultation", o, startOf(addDays(day, c.s.checkInAfterDays), c.tz), `Had a consultation on ${dateText(day)}${r.consultant ? ` with ${r.consultant}` : ""} and is ${still} in ${crm}.`, { ...values, visit_date: day }, c),
      ];
    }
  }

  const fu = r.followUpAt ?? null;
  const fuDay = fu ? dayOf(fu, c.tz) : null;
  // They came since enquiring (the front desk did not update the CRM): the calls after that visit take over.
  const came = cameSince(created, c);
  if (came) return [keep(fu ? "callback_due" : "new_enquiry", o, `Visited on ${dateText(came)} since enquiring, so the calls after that visit take over.`)];
  // Booked at the front desk since enquiring, and that booking's time has come: what came of it speaks for the enquiry.
  const desk = deskSince(created, c);
  if (desk) {
    const [sys, when] = [systemOf(desk), whenText(desk.startsAt, c)];
    const enquiry = fu ? "callback_due" : "new_enquiry";
    if (desk.status === "checked_in" || desk.status === "completed")
      return [keep(enquiry, o, `Came in on ${dateText(dayOf(desk.startsAt, c.tz))} since enquiring, as ${sys} shows, so JENAI does not call to book them.`)];
    if (isBooked(desk.status))
      return [keep("appointment_unclear", o, `Booked in ${sys} for ${when} since enquiring; that has passed and ${sys} still says booked, so JENAI cannot tell if they came. Update it in ${sys}.`)];
    return [keep(enquiry, o, `Booked in ${sys} for ${when} since enquiring, and ${BOOKING_STATUS_TEXT[desk.status]} there, so the calls about that booking take over.`)];
  }

  const age = created ? Math.max(0, daysBetween(created, c.today)) : null;
  // A noted callback keeps an older enquiry warm, but only while the callback itself is recent.
  if (fu && fuDay && daysBetween(fuDay, c.today) <= F) {
    return [callable("callback_due", o, fu, `The team noted a callback for ${dateText(fuDay)}${fu <= c.now ? ", and it is due" : ""}.`, values, c)];
  }
  if (age !== null && age <= F) {
    const fresh = c.now.getTime() - r.createdExt!.getTime() <= SPEED_TO_LEAD_MS;
    const when = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
    const about = r.treatment ? ` about ${r.treatment}` : "";
    const via = r.source ? ` through ${r.source}` : "";
    // Due since they asked, so the row stays the same from one plan to the next.
    return [
      callable("new_enquiry", o, r.createdExt!, `Enquired ${when}${about}${via}.${fresh ? " Called first: people book soonest right after they ask." : ""}`, values, c, {
        priority: fresh ? FRESH_ENQUIRY_PRIORITY : undefined,
      }),
    ];
  }
  if (fu && fuDay) return [keep("callback_due", o, `The team noted a callback for ${dateText(fuDay)}, ${plural(daysBetween(fuDay, c.today), "day")} ago. ${coldCall(F)}`)];
  if (age === null) return [keep("new_enquiry", o, `${crm} has no enquiry date for this record, so JENAI cannot tell how recent it is.`)];
  return [keep("new_enquiry", o, `Enquired ${plural(age, "day")} ago. ${coldCall(F)}`)];
}

const coldCall = (F: number) => `Older than ${F} days counts as a cold call, which needs a promotional number and consent.`;

function bookedRow(r: PlanRecord, o: Origin, c: Ctx, remind: (r: PlanRecord, o: Origin) => Draft): Draft {
  if (!r.appointmentAt) return keep("appointment_reminder", o, `${o.crm} says booked but has no appointment date, so JENAI cannot remind them. Add the date in ${o.crm}.`);
  if (passed(r, c)) return keep("appointment_unclear", o, `Their appointment date has passed and ${o.crm} still says booked, so JENAI cannot tell if they came. Update the status in ${o.crm}.`);
  return remind(r, o);
}

/** The appointment has passed: its time, or for a date with no time, the whole of its day. */
function passed(r: PlanRecord, c: Ctx): boolean {
  const a = r.appointmentAt!;
  return r.appointmentHasTime === false ? dayOf(a, c.tz) < c.today : a <= c.now;
}

/**
 * A reminder the evening before (the last calling day before, when the
 * evening before is not one), or 3 hours before an appointment later today.
 * The evening hour is kept inside the calling window. An appointment with a
 * date and no time is reminded only the evening before: on the day, a call
 * could come after it. Not moved by the gap between calls: they expect it,
 * and it is tied to the day.
 */
function reminderRow(appt: Date, timed: boolean, o: Origin, values: Values, c: Ctx, about = ""): Draft {
  const day = dayOf(appt, c.tz);
  const when = timed ? whenText(appt, c) : dateText(day);
  if (!timed && day === c.today)
    return keep("appointment_reminder", o, `Their appointment is today and ${o.crm} gives no time for it, so a reminder call now could come after it. With no time, JENAI reminds them the evening before.`);
  // The earliest the appointment can be: its time, or the start of its day.
  const begins = timed ? appt : startOf(day, c.tz);
  if (timed && appt.getTime() - c.now.getTime() < REMINDER_CUTOFF_MS) return keep("appointment_reminder", o, `Their appointment on ${when} is under 2 hours away: too close for a reminder call.`);
  const w = effectiveWindow(c.s.callingWindow);
  const evening = Math.min(Math.max(c.s.reminderHour * 60, w.start), w.end - END_GUARD_MIN - 1);
  let target: Date | null = null;
  if (day !== c.today) {
    for (let d = addDays(day, -1); d >= c.today && !target; d = addDays(d, -1))
      if (c.s.callingWindow.days.includes(weekday(d))) target = startOf(d, c.tz, evening);
  }
  target ??= new Date(begins.getTime() - SAME_DAY_REMINDER_MS);
  const due = target <= c.now;
  // When it can be made from now on; the row keeps the time it fell due.
  const next = nextWindowStart(due ? c.now : target, c.s.callingWindow, c.tz);
  if (next.getTime() > begins.getTime() - REMINDER_CUTOFF_MS) return keep("appointment_reminder", o, `No calling hours are left far enough before their appointment on ${when} for a reminder call.`);
  const at = nextWindowStart(target, c.s.callingWindow, c.tz);
  return { origin: o, journey: "appointment_reminder", verdict: due ? "call_now" : "scheduled", reason: `Appointment on ${when}${about}.`, callAt: at, priority: PLAN_JOURNEYS.appointment_reminder.priority, values };
}

/** A CRM's booking while their front desk has them booked: one reminder, from the front desk, which keeps the clinic's own diary. */
function byFrontDesk(o: Origin, b: PlanBooking, c: Ctx): Draft {
  const sys = systemOf(b);
  return keep("appointment_reminder", o, `Booked in ${sys} for ${whenText(b.startsAt, c)}: the reminder goes by ${sys}, the clinic's own system.`);
}

function noShowRow(r: PlanRecord, o: Origin, c: Ctx, again: (at: Date) => string | null): Draft {
  // An appointment still to come was reminded instead, so one here has passed.
  const ref = r.appointmentAt ?? r.createdExt ?? null;
  if (!ref) return keep("no_show_rebook", o, `${o.crm} has no appointment or enquiry date for this record, so JENAI cannot tell how recent it is.`);
  const day = dayOf(ref, c.tz);
  const came = cameSince(day, c);
  if (came) return keep("no_show_rebook", o, `Visited on ${dateText(came)} since ${r.appointmentAt ? "missing their appointment" : "enquiring"}, so the calls after that visit take over.`);
  const ago = Math.max(0, daysBetween(day, c.today));
  const what = r.appointmentAt ? `Missed their appointment on ${dateText(day)}` : `Marked "${r.status}" in ${o.crm}, enquiry from ${dateText(day)}`;
  if (ago > c.s.freshDays) return keep("no_show_rebook", o, `${r.appointmentAt ? "Missed their appointment" : "Enquired"} ${plural(ago, "day")} ago. ${coldCall(c.s.freshDays)}`);
  // Booked again, or seen at the front desk, since: the call to rebook is not needed.
  const since = again(ref);
  if (since) return keep("no_show_rebook", o, `${what}, but ${since}.`);
  return callable("no_show_rebook", o, ref, `${what}.`, recordValues(r, c), c);
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
    // A front desk booking always has its time of day.
    rows.push(reminderRow(first.startsAt, true, bookingOrigin(first), bookingValues(first, c), c, `${services.length ? ` for ${listText(services)}` : ""}, booked in ${systemOf(first)}`));
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
  // Due since it was missed, or since the cancellation was read when that came first, so the row keeps its time from one plan to the next.
  const due = new Date(Math.min(b.startsAt.getTime(), (b.changedAt ?? c.now).getTime(), c.now.getTime()));
  return callable(journey, o, due, `${what}.`, bookingValues(b, c), c);
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
    // A CRM appointment still to come counts whatever its status says, as for its reminder (a date with no time, all its day),
    // unless the front desk cancelled that day or, with no time to tell them apart, marked that day's booking a no-show.
    ...records
      .filter((r) => {
        if (!r.appointmentAt || passed(r, c) || contactOnly(r, c.s) || ["never", "unknown"].includes(classOf(r.status, c.s))) return false;
        const day = dayOf(r.appointmentAt, c.tz);
        return !cancelledOn(bookings, r.appointmentAt, c) && !(r.appointmentHasTime === false && bookings.some((b) => b.status === "no_show" && dayOf(b.startsAt, c.tz) === day));
      })
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
  return {
    type: "clinic_appointment",
    id: b.id,
    label: `${b.system ?? "Front desk"} booking`,
    name: b.name ?? null,
    centre: b.centre ?? null,
    centreNames: [...(b.centre ? [b.centre] : []), ...(b.centreKnownAs ?? [])],
    source: null,
    // A booking stands for the day it was for: a "no" said on a CRM record after that day covers it, one said before does not.
    // One cancelled ahead of its day stands for when the cancellation was read, so a "no" said after that covers it too.
    enquiredAt: b.status === "cancelled" && b.changedAt && b.changedAt < b.startsAt ? b.changedAt : b.startsAt,
    crm: systemOf(b),
  };
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

/** A break between sittings up to this many times the treatment's usual gap (a sitting or two put off) is still the same course. */
const COURSE_GAP_INTERVALS = 2.5;
/** A course check-in comes at least this many days after the sitting, so they can say how they have been. */
const CHECKIN_MIN_DAYS = 7;
/** The cap on calls to one person counts the calls of this many days. */
const CAP_DAYS = 30;

/**
 * After a visit, per treatment, from its latest sitting. A course (sittings
 * left on a package, a set number of sittings, or sittings at a set gap with
 * no end) gets one call per sitting, not three: feedback after the first,
 * then before each next sitting one check-in that asks how they have been and
 * whether they see a difference and books it; after the last, the result
 * check and later maintenance. A service given once gets feedback, the
 * result check and maintenance. Feedback is asked once per visit day however
 * many services they had.
 *
 * A course is the run of sittings of one treatment (the treatment rule it
 * matches, or the service's name when only the rule for any other service
 * does) with no break longer than the course gap: a longer break starts a new
 * one. Their package for it, when their front desk says, decides the sittings
 * left and when it ends. A check-in or maintenance overdue by more than
 * recallWithinDays has lapsed: calling them now would be a win-back offer,
 * not care. Sessions left on a package they paid for are theirs, so a call
 * about those is never a win-back.
 */
function visitRows(all: VisitIn[], c: Ctx, bookedFor: (key: string) => string | null): Draft[] {
  const groups = new Map<string, VisitIn[]>();
  for (const v of all) {
    const key = treatmentKey(v.service, c.rules);
    const g = groups.get(key);
    if (g) g.push(v);
    else groups.set(key, [v]);
  }
  const rows: Draft[] = [];
  const feedbackDays = new Set<string>();
  for (const [key, g] of groups) {
    g.sort((a, b) => a.day.localeCompare(b.day) || a.origin.id.localeCompare(b.origin.id));
    const last = g[g.length - 1]!;
    const onDay = g.filter((v) => v.day === last.day);
    const rule = ruleFor(last.service, c.rules);
    const every = rule.sessionIntervalDays;
    // Every service of this treatment they had that day, as the clinic names it.
    const named = listText([...new Map(onDay.filter((v) => v.service.trim()).map((v) => [serviceKey(v.service), v.service.trim()])).values()]);
    const what = named || "their visit";
    const note = rule.isDefault ? " Timing is JENAI's default until the clinic's doctors confirm it." : "";
    const values: Values = { visit_date: last.day, last_visit: last.day, treatment: named || null, doctor: last.doctor, branch: last.branch };
    const after = (n: number) => startOf(addDays(last.day, n), c.tz);
    const recall = (journey: PlanJourney, days: number, reason: string) =>
      daysBetween(addDays(last.day, days), c.today) > c.s.recallWithinDays
        ? keep(journey, last.origin, `Lapsed: last had ${what} on ${dateText(last.day)}. A call now would be a win-back offer, which needs a promotional number and consent.`)
        : callable(journey, last.origin, after(days), reason, values, c);
    const feedback = () => {
      if (rule.feedbackAfterDays === null || daysBetween(last.day, c.today) > c.s.feedbackWithinDays || feedbackDays.has(last.day)) return;
      feedbackDays.add(last.day);
      rows.push(callable("visit_feedback", last.origin, after(rule.feedbackAfterDays), `Visited on ${dateText(last.day)}${named ? ` for ${named}` : ""}.`, values, c));
    };
    const resultCheck = (had: string) => {
      const n = rule.resultCheckAfterDays;
      if (n === null) return;
      const due = addDays(last.day, n);
      if (daysBetween(due, c.today) <= c.s.resultCheckWithinDays)
        rows.push(callable("result_check", last.origin, startOf(due, c.tz), `${had} on ${dateText(last.day)}; results usually show by about ${plural(n, "day")}.${note}`, { ...values, review_due: due }, c));
    };
    const maintenance = (had: string) => {
      const m = rule.maintenanceAfterDays;
      if (m) rows.push(recall("maintenance", m, `${had} on ${dateText(last.day)}; maintenance is due every ${plural(m, "day")}.${note}`));
    };

    // This course's sittings: back from the latest to the first break longer than the course gap.
    const gap = Math.max(Math.ceil(COURSE_GAP_INTERVALS * (every ?? 0)), c.s.courseGapDays);
    const days = [...new Set(g.map((v) => v.day))];
    let start = days.length - 1;
    while (start > 0 && daysBetween(days[start - 1]!, days[start]!) <= gap) start--;
    const sittings = days.length - start;

    const pkg = packageFor(onDay, c);
    const p = pkg?.p;
    // Sessions used on the package that speaks for the course, when it says.
    const used = p && (pkg.kind === "open" || pkg.kind === "complete") ? (p.used ?? (p.total != null && pkg.left !== null ? p.total - pkg.left : null)) : null;
    // Which sitting the latest was: the clinic's own count (the package in use, the visit list's), else the sittings JENAI has seen.
    const count = (used !== null && used >= 1 ? used : null) ?? last.sessionsDone ?? sittings;
    const first = count === 1 && sittings === 1;
    let length: number | null;
    let left: number | null;
    if (pkg?.kind === "open") [length, left] = [p!.total ?? (used !== null ? used + pkg.left! : null) ?? last.sessionsTotal, pkg.left];
    else if (pkg?.kind === "complete") [length, left] = [p!.total ?? used ?? last.sessionsTotal ?? count, 0];
    else {
      length = last.sessionsTotal ?? rule.courseSessions;
      left = length !== null ? Math.max(0, length - count) : null;
    }
    // A rule with a maintenance gap and no number of sittings (a facial) is a service given once, then kept up.
    const course = pkg ? pkg.kind !== "complete" || (length ?? 0) > 1 : length !== null ? length > 1 : every !== null && !rule.maintenanceAfterDays;

    if (!course) {
      feedback();
      resultCheck(`Had ${what}`);
      maintenance(length !== null ? `Finished the course of ${what}` : `Had ${what}`);
    } else if (pkg?.kind === "frozen") {
      if (first) feedback();
      rows.push(keep("course_checkin", last.origin, `Their package for ${what} is on hold in ${systemOf(pkg.p)}${pkg.left ? ` with ${plural(pkg.left, "session")} left` : ""}, so no call about the next sitting while it is.`));
    } else if (pkg?.kind === "ended") {
      // The course stopped there: how it came out, and no sitting to book.
      if (first) feedback();
      resultCheck(`Had ${what}`);
      const q = pkg.p;
      const how = q.status === "cancelled" ? `was cancelled in ${systemOf(q)}` : q.expiresOn && q.expiresOn < c.today ? `ended on ${dateText(q.expiresOn)}` : `has expired in ${systemOf(q)}`;
      rows.push(keep("course_checkin", last.origin, `Their package for ${what} ${how}${pkg.left ? ` with ${plural(pkg.left, "session")} unused` : ""}, so there is no next sitting to call about.`));
    } else if (left === 0) {
      // The last sitting: how the course came out, then maintenance.
      resultCheck(`Finished the course of ${what}`);
      maintenance(`Finished the course of ${what}`);
    } else {
      if (first) feedback();
      // A package bought again and not started yet: the latest sitting was the course before it, and the next is its first.
      const restart = pkg?.kind === "open" && used === 0;
      const nextNo = pkg?.kind === "open" ? (used !== null ? used + 1 : null) : count + 1;
      rows.push(checkinRow({ last, what, every, pkg, note, values, length, left, lastNo: restart ? null : count, nextNo, booked: bookedFor(key) }, c));
    }
  }
  return rows;
}

/** A course's latest sitting, as its check-in needs it. */
interface Checkin {
  last: VisitIn;
  what: string;
  every: number | null;
  pkg: PackageState | null;
  note: string;
  values: Values;
  /** Sittings in the course, and left in it, when known. */
  length: number | null;
  left: number | null;
  /** Which sitting the latest was, and which the next is, when known. */
  lastNo: number | null;
  nextNo: number | null;
  /** Their next sitting already booked, in words, or null. */
  booked: string | null;
}

/**
 * The one call between two sittings of a course: checkinLeadDays before the
 * next is due, and at least a week after the last so they can say how they
 * have been. None when the next sitting is already booked: the reminder
 * before it is the call. With sessions left on a package that ends within
 * packageEndingWithinDays, no later than when it came that close to its end,
 * so they can book before it does.
 */
function checkinRow(k: Checkin, c: Ctx): Draft {
  const { last, what } = k;
  const o = last.origin;
  if (k.booked) return keep("course_checkin", o, `${k.booked}: the reminder before it is the call.`);
  const open = k.pkg?.kind === "open" ? k.pkg : null;
  const next = k.every ? addDays(last.day, k.every) : null;
  const sitting = k.nextNo !== null && k.length !== null && k.nextNo <= k.length ? `Sitting ${k.nextNo} of ${k.length} of ${what}` : `The next sitting of ${what}`;
  const values: Values = { ...k.values, sitting_number: k.lastNo ? String(k.lastNo) : null, sessions_left: k.left !== null ? String(k.left) : null, next_due: next };
  // What the call is about, from what its script is told, so the clinic reads what the call will say.
  const step = `${courseStepText(values) ?? `The next sitting of ${what}`}.`;
  const lastText = `The last sitting was on ${dateText(last.day)}`;
  const ends = open?.p.expiresOn ?? null;
  // A week after the sitting at the soonest; when their package ends before then, the day after, so they can still book.
  const soonest = addDays(last.day, ends && ends <= addDays(last.day, CHECKIN_MIN_DAYS) ? 1 : CHECKIN_MIN_DAYS);
  const usual = next ? later(addDays(next, -c.s.checkinLeadDays), soonest) : null;
  if (open && ends && daysBetween(c.today, ends) <= c.s.packageEndingWithinDays) {
    // A fixed day, never later than when the package came that close to its end, so the row stays the same from one plan to the next.
    const near = later(addDays(ends, -c.s.packageEndingWithinDays), soonest);
    const day = usual && usual < near ? usual : near;
    const why = `${step} ${plural(open.left!, "session")} left, package ends on ${dateText(ends)}: called in time to book before it does. ${lastText}.`;
    return { ...callable("course_checkin", o, startOf(day, c.tz), why, values, c), lead: step };
  }
  if (!next || !usual)
    return keep(
      "course_checkin",
      o,
      open
        ? `${plural(open.left!, "session")} of ${what} left on ${theirPackage(open.p)}, but no gap between sessions is set for it, so JENAI cannot tell when the next is due. Add one in the treatment rules.`
        : `${sitting} is next, but no gap between sittings is set for it, so JENAI cannot tell when it is due. Add one in the treatment rules.`,
    );
  // With no package, a course long past its next sitting has lapsed.
  if (!open && daysBetween(next, c.today) > c.s.recallWithinDays)
    return keep("course_checkin", o, `Lapsed: last had ${what} on ${dateText(last.day)}. A call now would be a win-back offer, which needs a promotional number and consent.`);
  const pkgText = open ? ` ${plural(open.left!, "session")} left on ${theirPackage(open.p)}${ends ? `, which ends on ${dateText(ends)}` : ""}.` : "";
  const why = `${step} ${lastText}, and sittings are ${plural(k.every!, "day")} apart.${pkgText}${k.note}`;
  return { ...callable("course_checkin", o, startOf(usual, c.tz), why, values, c), lead: step };
}

/**
 * Where a course check-in stands, from the variables its script is told:
 * "Laser Toning, sitting 4 of 6: check in and book sitting 5, due 22 Oct".
 * The plan's reason leads with it, so the clinic reads what the call will
 * say. The command line leaves the treatment out (treatment: false), since
 * terminals are logged. Null for a call with no course in its context: any
 * other kind of call, or one kept out.
 */
export function courseStepText(context: Readonly<Record<string, unknown>> | null | undefined, opts: { treatment?: boolean } = {}): string | null {
  const text = (k: string) => {
    const v = context?.[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const count = (k: string) => {
    const v = Number(text(k) ?? NaN);
    return Number.isInteger(v) && v >= 0 ? v : null;
  };
  const lastVisit = text("last_visit");
  if (!lastVisit || !/^\d{4}-\d{2}-\d{2}$/.test(lastVisit)) return null;
  const n = count("sitting_number") || null;
  const left = count("sessions_left");
  const due = text("next_due");
  const where = n ? `sitting ${n}${left !== null ? ` of ${n + left}` : ""}` : left !== null ? plural(left, "sitting") + " left" : null;
  const treatment = opts.treatment === false ? null : text("treatment");
  const book = `check in and book ${n ? `sitting ${n + 1}` : "the next sitting"}${due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? `, due ${shortDate(due, lastVisit)}` : ""}`;
  const out = [[treatment, where].filter(Boolean).join(", "), book].filter(Boolean).join(": ");
  // A treatment keeps the clinic's own spelling; a sentence of ours starts with a capital.
  return treatment ? out : out.charAt(0).toUpperCase() + out.slice(1);
}

/** "22 Oct", with the year when it is not the year of `from`: "10 Jan 2027". */
function shortDate(day: string, from: string): string {
  const [y, m, d] = ymd(day);
  return `${d} ${MONTHS[m - 1]}${day.slice(0, 4) === from.slice(0, 4) ? "" : ` ${y}`}`;
}

const theirPackage = (p: PlanPackage) => (p.status === "not_started" ? "the package they bought, not started yet" : "their package");
/** The later of two days. */
const later = (a: string, b: string) => (a > b ? a : b);

/** A service's name as visits and packages are matched on: any case, any spacing. */
const serviceKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Which treatment a service is, for telling one course from another: the
 * treatment rule it matches, so "Laser Toning - Lips" and "lip toning" are one
 * course, or its own name when only the rule for any other service matches.
 */
function treatmentKey(service: string, rules: readonly PlanRule[]): string {
  const r = ruleFor(service, rules);
  return r.match.length ? `rule:${rules.indexOf(r)}` : `service:${serviceKey(service)}`;
}

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

/** Of their packages for the services of one sitting, the one that speaks for the course: as packageRank says, then ending soonest. */
function packageFor(onDay: readonly VisitIn[], c: Ctx): PackageState | null {
  let best: PackageState | null = null;
  for (const p of c.packages) {
    if (!onDay.some((v) => covers(p, serviceKey(v.service), v))) continue;
    const st = packageState(p, onDay[0]!.day, c.today);
    if (!st) continue;
    const ends = (x: PackageState) => x.p.expiresOn ?? "9999-12-31";
    if (!best || packageRank(st) < packageRank(best) || (packageRank(st) === packageRank(best) && ends(st) < ends(best))) best = st;
  }
  return best;
}

/**
 * A call that will be made: due now once its time has come, otherwise
 * scheduled for it; never within minGapDays of the last call with them, nor
 * while they have had maxCallsPer30Days calls in the 30 days before it;
 * always inside calling hours. A call already due keeps the calling moment it
 * fell due at, so the row stays the same from one plan to the next; it is
 * made at the next calling moment from now.
 */
function callable(journey: PlanJourney, o: Origin, due: Date, reason: string, values: Values, c: Ctx, opts: { priority?: number } = {}): Draft {
  let at = due;
  let verdict: PlannedCallVerdict = due > c.now ? "scheduled" : "call_now";
  let why = "";
  if (c.lastCallAt && c.s.minGapDays > 0) {
    const free = new Date(c.lastCallAt.getTime() + c.s.minGapDays * DAY_MS);
    if (free > at && free > c.now) [at, verdict, why] = [free, "scheduled", `the last call with them was on ${dateText(dayOf(c.lastCallAt, c.tz))}, and calls are kept ${plural(c.s.minGapDays, "day")} apart.`];
  }
  // Counted at the time the call would go. This call is the one more: it waits until the oldest call that fills the cap is 30 days old.
  const goes = at > c.now ? at : c.now;
  const counted = c.recentCalls.filter((x) => x <= goes && goes.getTime() - x.getTime() < CAP_DAYS * DAY_MS);
  const max = c.s.maxCallsPer30Days;
  if (counted.length >= max) {
    const free = new Date(counted[max - 1]!.getTime() + CAP_DAYS * DAY_MS);
    if (free > at)
      [at, verdict, why] = [free, "scheduled", `they have had ${plural(counted.length, "call")} since ${dateText(dayOf(counted.at(-1)!, c.tz))}, and the plan settings allow ${max} in any ${CAP_DAYS} days.`];
  }
  at = nextWindowStart(at, c.s.callingWindow, c.tz);
  if (why) reason += ` Moved to ${dateText(dayOf(at, c.tz))}: ${why}`;
  return { origin: o, journey, verdict, reason, callAt: at, priority: opts.priority ?? PLAN_JOURNEYS[journey].priority, values };
}

function keep(journey: PlanJourney, o: Origin, reason: string): Draft {
  return { origin: o, journey, verdict: "kept_out", reason, callAt: null, priority: 0, values: {} };
}

type StatusClass = "never" | "no_show" | "booked" | "customer" | "open" | "unknown";

/** Only in a module that is a list of people (Zoho Contacts), with no status: no enquiry or booking of its own. */
const contactOnly = (r: PlanRecord, s: PlanSettings) => !statusOf(r.status) && inList(s.contactOnlyModules, r.module);

/** A record with no status is an enquiry not yet worked. */
function classOf(status: string | null | undefined, s: PlanSettings): StatusClass {
  if (!statusOf(status)) return "open";
  const st = status!;
  if (inList(s.neverStatuses, st) || inList(s.doNotCallStatuses, st) || inList(s.declinedStatuses, st)) return "never";
  if (inList(s.noShowStatuses, st)) return "no_show";
  if (inList(s.bookedStatuses, st)) return "booked";
  if (inList(s.customerStatuses, st)) return "customer";
  if (inList(s.openStatuses, st)) return "open";
  return "unknown";
}

/** The status list a CRM status falls in under these settings, or null when none: what the settings page shows against each status seen. */
export function statusListOf(status: string, s: PlanSettings): StatusList | null {
  return STATUS_LISTS.find((k) => inList(s[k], status)) ?? null;
}

/** Words compared the way people type them: any case, spacing or punctuation. */
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const inList = (list: readonly string[], v: string) => list.some((x) => norm(x) === norm(v));
/** An empty pick list shows as "-None-" on Zoho's screens; treated as no status wherever it comes from. */
const statusOf = (s: string | null | undefined) => (norm(s) === "none" ? "" : norm(s));

/**
 * Whether a centre the plan covers is one of these names: the same name, or
 * one inside the other ("Kondapur" and "Zennara Clinics Kondapur"), the way
 * the visit list's branches are matched.
 */
function covered(centres: readonly string[], names: readonly string[]): boolean {
  return names.some((n) => {
    const a = norm(n);
    return centres.some((x) => {
      const b = norm(x);
      return !!a && !!b && (a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))));
    });
  });
}

function recordOrigin(r: PlanRecord): Origin {
  const one = r.module.endsWith("s") ? r.module.slice(0, -1) : r.module;
  return {
    type: "crm_record",
    id: r.id,
    label: `${r.crm ?? "CRM"} ${one}`,
    name: r.name ?? null,
    centre: r.centre ?? null,
    centreNames: r.centre ? [r.centre] : [],
    source: r.source ?? null,
    enquiredAt: r.createdExt ?? null,
    crm: r.crm ?? "their CRM",
  };
}

function visitIn(v: PlanVisit): VisitIn {
  return {
    origin: {
      type: "visit",
      id: v.id,
      // Read from a connected system, it says which: "Zenoti visit".
      label: v.system ? `${v.system} visit` : v.source && v.source !== "upload" ? "Visit record" : "Visit list",
      name: v.name ?? null,
      centre: v.branch ?? null,
      centreNames: [...(v.branch ? [v.branch] : []), ...(v.branchKnownAs ?? [])],
      source: null,
      enquiredAt: null,
      crm: "their CRM",
    },
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
    // A date with no time has no time to say: never "12:00 AM".
    appointment_time: appt && r.appointmentHasTime !== false ? timeText(appt, c.tz) : null,
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
  /** Rows new or changed since the last plan; the rest were left as they were. */
  written: number;
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
 * planned_calls: rows that changed are updated in place (same id), rows that
 * did not are left alone, rows for records, visits, bookings or calls that no
 * longer apply are removed. Reads crm_records (not deleted), visits, front
 * desk bookings (clinic_appointments), package balances and guests
 * (external_people), the do-not-call entries and contacts of the numbers in
 * them, recent calls, plan settings and treatment rules. A visit still
 * waiting for its phone number is counted, not planned; a booking or package
 * with no number known is left out. Records when the plan was worked out, and
 * when it is next due again, in call_plan_settings.
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
    const branchList = await tx.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches);
    const branchName = new Map(branchList.map((b) => [b.id, b.name]));
    const knownAs = new Map(branchList.map((b) => [b.id, [b.name, ...(b.code ? [b.code] : [])]]));
    const centreName = new Map(
      connections.flatMap((i) =>
        (Array.isArray(i.config.centres) ? i.config.centres : []).flatMap((x) => {
          const c = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
          const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : typeof c.code === "string" && c.code.trim() ? c.code.trim() : null;
          return typeof c.id === "string" && name ? [[`${i.id}:${c.id}`, name] as const] : [];
        }),
      ),
    );
    const theirCentre = (integrationId: string | null, centreRef: string | null) => (integrationId && centreRef ? centreName.get(`${integrationId}:${centreRef}`) : undefined);
    const placeOf = (integrationId: string | null, branchId: string | null, centreRef: string | null, own: string | null) =>
      (branchId ? branchName.get(branchId) : undefined) ?? theirCentre(integrationId, centreRef) ?? own;
    // Every other name the centre goes by, for the centres the plan covers: the branch it was matched to, their system's name, the row's own text.
    const namesOf = (integrationId: string | null, branchId: string | null, centreRef: string | null, own: string | null) => [
      ...new Set([...(branchId ? (knownAs.get(branchId) ?? []) : []), theirCentre(integrationId, centreRef), own].filter((x): x is string => !!x)),
    ];
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
        changedAt: clinicAppointments.updatedAt,
      })
      .from(clinicAppointments);
    const held = await tx.select().from(packageBalances);
    // Only the numbers in this plan: the platform's own lists can be long. A
    // front desk's count too: its bookings, and its guests' profiles, which
    // give a number to visits and packages read without one.
    const inPlan = sql`(select phone_e164 from crm_records where deleted_at is null and phone_e164 is not null
      union select phone_e164 from visits where phone_e164 is not null
      union select phone_e164 from clinic_appointments where phone_e164 is not null
      union select phone_e164 from external_people where phone_e164 is not null)`;
    const blocked = await tx
      .select({ phone: suppressions.phoneE164, reason: suppressions.reason, scope: suppressions.scope, expiresAt: suppressions.expiresAt })
      .from(suppressions)
      .where(and(or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, now)), sql`${suppressions.phoneE164} in ${inPlan}`));
    // Only calls recent enough to hold the next one back.
    const who = sql<string>`case when ${calls.direction} = 'inbound' then ${calls.fromE164} else ${calls.toE164} end`;
    const lastCalls = settings.minGapDays
      ? await tx
          .select({ phone: who, at: sql<Date>`max(${calls.startedAt})`.mapWith(calls.startedAt) })
          .from(calls)
          .where(gt(calls.startedAt, new Date(now.getTime() - settings.minGapDays * DAY_MS)))
          .groupBy(who)
      : [];
    // Calls made to them in the last 30 days, for the cap on calls in any 30 days: every one that left the dialer, answered or not.
    const made = await tx
      .select({ phone: calls.toE164, at: calls.startedAt })
      .from(calls)
      .where(
        and(
          eq(calls.direction, "outbound"),
          notInArray(calls.status, ["queued", "failed"]),
          gt(calls.startedAt, new Date(now.getTime() - CAP_DAYS * DAY_MS)),
          lte(calls.startedAt, now),
          sql`${calls.toE164} in ${inPlan}`,
        ),
      );
    const programs = new Set((await tx.selectDistinct({ key: clientPrograms.programKey }).from(clientPrograms)).map((p) => p.key));
    const contactOf = new Map((await tx.select({ id: contacts.id, phone: contacts.phoneE164 }).from(contacts).where(sql`${contacts.phoneE164} in ${inPlan}`)).map((x) => [x.phone, x.id]));

    // One person per number. A record whose number could not be read stands alone.
    const people = new Map<string, PlanPerson>();
    const personFor = (key: string, phone: string | null) => {
      let p = people.get(key);
      if (!p) people.set(key, (p = { phone, records: [], visits: [], bookings: [], packages: [], suppressions: [], lastCallAt: null, recentCalls: [], contactId: phone ? (contactOf.get(phone) ?? null) : null, programs }));
      return p;
    };
    for (const r of records) personFor(r.phoneE164 ?? `record:${r.id}`, r.phoneE164).records.push({ ...r, crm: systemNamed(r.integrationId) ?? "their CRM" });
    // A booking, package or visit carries the number known when it was read; their guest record may know it since.
    const guestPhone = new Map(guests.filter((g) => g.phone).map((g) => [`${g.integrationId}:${g.ref}`, g.phone!]));
    const phoneOf = (x: { integrationId: string | null; guestRef: string | null; phone?: string | null; phoneE164?: string | null }) =>
      x.phone ?? x.phoneE164 ?? (x.integrationId && x.guestRef ? guestPhone.get(`${x.integrationId}:${x.guestRef}`) : undefined) ?? null;
    const visitOf = (v: (typeof taken)[number], phone: string): PlanVisit => ({
      ...v,
      phoneE164: phone,
      branch: placeOf(v.integrationId, v.branchId, v.centreRef, v.branch),
      branchKnownAs: namesOf(v.integrationId, v.branchId, v.centreRef, v.branch),
      system: v.integrationId ? systemNamed(v.integrationId) : undefined,
    });
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
      if (phone)
        personFor(phone, phone).bookings!.push({
          ...b,
          centre: placeOf(b.integrationId, b.branchId, b.centreRef, null),
          centreKnownAs: namesOf(b.integrationId, b.branchId, b.centreRef, null),
          system: systemNamed(b.integrationId),
        });
    }
    // A package alone prompts no call: it only tells the calls about visits and bookings how the course stands.
    for (const k of held) {
      const phone = phoneOf(k);
      if (phone) people.get(phone)?.packages!.push({ ...k, system: systemNamed(k.integrationId) });
    }
    for (const b of blocked) people.get(b.phone)?.suppressions!.push({ reason: b.reason, scope: b.scope, expiresAt: b.expiresAt });
    for (const l of lastCalls) {
      const p = l.phone ? people.get(l.phone) : undefined;
      if (p && l.at) p.lastCallAt = l.at;
    }
    for (const m of made) if (m.phone) people.get(m.phone)?.recentCalls!.push(m.at);

    const rows = new Map<string, PlanRow>();
    for (const p of people.values()) for (const row of planPerson(p, settings, rules, now)) rows.set(`${row.originType}:${row.originId}:${row.journey}`, row);
    const list = [...rows.values()];

    let written = 0;
    for (let n = 0; n < list.length; n += CHUNK) {
      const changed = await tx
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
          // A row the plan works out the same again is left as it is: no rewrite, no new version of it.
          setWhere: sql`(${plannedCalls.contactId}, ${plannedCalls.phoneE164}, ${plannedCalls.name}, ${plannedCalls.programKey}, ${plannedCalls.verdict}, ${plannedCalls.reason}, ${plannedCalls.callAt}, ${plannedCalls.priority}, ${plannedCalls.originLabel}, ${plannedCalls.context})
            is distinct from (excluded.contact_id, excluded.phone_e164, excluded.name, excluded.program_key, excluded.verdict, excluded.reason, excluded.call_at, excluded.priority, excluded.origin_label, excluded.context)`,
        })
        .returning({ id: plannedCalls.id });
      written += changed.length;
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
    // When this plan was worked out, and when it is due again, as the days move calls along.
    await tx
      .insert(callPlanSettings)
      .values({ tenantId, computedAt: sql`now()`, nextReplanAt: sql`now() + make_interval(mins => ${REPLAN_EVERY_MINUTES})` })
      .onConflictDoUpdate({
        target: callPlanSettings.tenantId,
        set: { computedAt: sql`now()`, nextReplanAt: sql`now() + make_interval(mins => ${REPLAN_EVERY_MINUTES})`, replanLeaseUntil: null },
      });

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
    return { people: people.size, rows: list.length, written, removed: removed.length, byVerdict, byJourney, waitingForPhone, marketingConsent };
  });
}

/**
 * Removes planned calls whose record, visit or front desk booking is gone, at
 * once, in the caller's transaction: after a connection is removed or pointed at
 * another account, their names, numbers and treatments must not wait in the
 * plan for its next working out.
 */
export async function dropOrphanedPlanRows(tx: Tx): Promise<number> {
  const gone = await tx.execute(sql`
    delete from planned_calls p
    where (p.origin_type = 'crm_record' and not exists (select 1 from crm_records c where c.tenant_id = p.tenant_id and c.id = p.origin_id and c.deleted_at is null))
       or (p.origin_type = 'visit' and not exists (select 1 from visits v where v.tenant_id = p.tenant_id and v.id = p.origin_id))
       or (p.origin_type = 'clinic_appointment' and not exists (select 1 from clinic_appointments a where a.tenant_id = p.tenant_id and a.id = p.origin_id))
    returning p.id`);
  return gone.length;
}
