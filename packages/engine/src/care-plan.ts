/**
 * The call plan: for every person in a client's records, which call JENAI
 * would make, when and why, or why it would not call them at all.
 *
 * Two sources: the client's CRM as last read (crm_records: enquiries,
 * callbacks, appointments) and the services people actually took (visits,
 * from the clinic's own software). planPerson() decides for one person and is
 * pure; replanTenant() reads one client's sources, plans everyone and stores
 * the result in planned_calls.
 *
 * This is a preview. Nothing here dials, creates campaign targets or writes to
 * the client's CRM. No promotional call is ever planned: an offer needs a
 * promotional number and recorded consent, which a plan cannot assume.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  callPlanSettings,
  calls,
  clientPrograms,
  contacts,
  crmRecords,
  integrations,
  organizations,
  plannedCalls,
  suppressionReason,
  suppressions,
  treatmentRules,
  visits,
  withTenant,
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
  next_session: { program: "clinic.revisit_recall", label: "Book their next session", priority: 20 },
  maintenance: { program: "clinic.revisit_recall", label: "Book their maintenance session", priority: 10 },
  appointment_unclear: { program: "", label: "Appointment outcome unknown", priority: 0 },
  no_call: { program: "", label: "No call", priority: 0 },
} as const;
export type PlanJourney = keyof typeof PLAN_JOURNEYS;

/** Priority given to a new enquiry made within the last day: above every other enquiry call. */
const FRESH_ENQUIRY_PRIORITY = 55;

/** Calls whose point is to get them booked: an appointment already coming up makes them wait. */
const BOOKING_JOURNEYS = new Set<PlanJourney>(["callback_due", "new_enquiry", "no_show_rebook", "next_session", "maintenance"]);

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
  timezone: "Asia/Kolkata",
};

type NumberKey = "freshDays" | "minGapDays" | "reminderHour" | "consultationWithinDays" | "checkInAfterDays" | "feedbackWithinDays" | "resultCheckWithinDays";
type ListKey = "openStatuses" | "bookedStatuses" | "noShowStatuses" | "customerStatuses" | "neverStatuses" | "doNotCallStatuses" | "centres" | "contactOnlyModules";
const NUMBER_LIMITS: Record<NumberKey, [number, number]> = {
  freshDays: [1, 365],
  minGapDays: [0, 60],
  reminderHour: [0, 23],
  consultationWithinDays: [1, 365],
  checkInAfterDays: [0, 60],
  feedbackWithinDays: [1, 90],
  resultCheckWithinDays: [1, 180],
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
}

export type SuppressionReason = (typeof suppressionReason.enumValues)[number];

/** Everything known about one person: every record and visit with their number. */
export interface PlanPerson {
  /** Their number in E.164, or null for a record whose number could not be read. */
  phone: string | null;
  records: PlanRecord[];
  visits: PlanVisit[];
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
  const c: Ctx = {
    s: settings,
    rules,
    now,
    tz,
    today: dayOf(now, tz),
    lastCallAt: person.lastCallAt ?? null,
    personName: person.records.find((r) => r.name)?.name ?? person.visits.find((v) => v.name)?.name ?? null,
  };
  const drafts: Draft[] = [];
  const uploaded = person.visits.filter((v) => v.visitDate <= c.today).map((v) => visitIn(v));
  const uploadedDays = new Set(uploaded.map((v) => v.day));
  const derived: VisitIn[] = [];
  const isContactOnly = (r: PlanRecord) => !statusOf(r.status) && inList(settings.contactOnlyModules, r.module);
  const hasEnquiry = person.records.some((r) => !isContactOnly(r));

  for (const r of person.records) {
    const o = recordOrigin(r);
    const crm = r.crm ?? "their CRM";
    if (isContactOnly(r)) {
      if (!hasEnquiry && !uploaded.length) drafts.push(keep("no_call", o, `Only in ${crm} ${r.module}: no enquiry or visit on record.`));
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
        // Still booked in their CRM, but the visit list shows they came: the visit speaks for it.
        if (!(r.appointmentAt && r.appointmentAt <= now && uploadedDays.has(dayOf(r.appointmentAt, tz)))) drafts.push(bookedRow(r, o, c));
        break;
      case "no_show":
        drafts.push(noShowRow(r, o, c));
        break;
      case "customer": {
        const appt = r.appointmentAt;
        if (appt && appt > now) drafts.push(reminderRow(r, o, c));
        else if (appt) {
          // Their visit, unless the visit list already has that day.
          const day = dayOf(appt, tz);
          if (!uploadedDays.has(day)) derived.push({ origin: o, service: r.treatment ?? "", day, doctor: r.consultant ?? null, branch: r.centre ?? null, sessionsDone: null, sessionsTotal: null });
        } else if (!uploaded.length) {
          drafts.push(keep("no_call", o, `${crm} has no visit date for this patient. Upload the visit list so JENAI knows what they had and when.`));
        }
        break;
      }
    }
  }

  const all = [...uploaded, ...derived];
  drafts.push(...visitRows(all, c));
  // Everyone shows in the plan, including a patient none of whose calls is due any more.
  if (!drafts.length && all.length) {
    const last = all.reduce((a, b) => (b.day > a.day ? b : a));
    drafts.push(keep("no_call", last.origin, `Last visit on ${dateText(last.day)}${last.service ? ` for ${last.service}` : ""}: no call about it is due any more.`));
  }

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

function bookedRow(r: PlanRecord, o: Origin, c: Ctx): Draft {
  const crm = r.crm ?? "their CRM";
  if (!r.appointmentAt) return keep("appointment_reminder", o, `${crm} says booked but has no appointment date, so JENAI cannot remind them. Add the date in ${crm}.`);
  if (r.appointmentAt <= c.now) return keep("appointment_unclear", o, `Their appointment date has passed and ${crm} still says booked, so JENAI cannot tell if they came. Update the status in ${crm}.`);
  return reminderRow(r, o, c);
}

/**
 * A reminder the evening before (the last calling day before, when the
 * evening before is not one), or 3 hours before an appointment later today.
 * Not moved by the gap between calls: they expect it, and it is tied to the day.
 */
function reminderRow(r: PlanRecord, o: Origin, c: Ctx): Draft {
  const appt = r.appointmentAt!;
  const day = dayOf(appt, c.tz);
  const when = `${dateText(day)} at ${timeText(appt, c.tz)}`;
  const values = recordValues(r, c);
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
  return { origin: o, journey: "appointment_reminder", verdict: due ? "call_now" : "scheduled", reason: `Appointment on ${when}.`, callAt: at, priority: PLAN_JOURNEYS.appointment_reminder.priority, values };
}

function noShowRow(r: PlanRecord, o: Origin, c: Ctx): Draft {
  const crm = r.crm ?? "their CRM";
  const ref = r.appointmentAt ?? r.createdExt ?? null;
  if (!ref) return keep("no_show_rebook", o, `${crm} has no appointment or enquiry date for this record, so JENAI cannot tell how recent it is.`);
  const day = dayOf(ref, c.tz);
  const ago = Math.max(0, daysBetween(day, c.today));
  const what = r.appointmentAt ? `Missed their appointment on ${dateText(day)}` : `Marked "${r.status}" in ${crm}, enquiry from ${dateText(day)}`;
  if (ago > c.s.freshDays) return keep("no_show_rebook", o, `${r.appointmentAt ? "Missed their appointment" : "Enquired"} ${plural(ago, "day")} ago. ${coldCall(c.s.freshDays)}`);
  return callable("no_show_rebook", o, c.now, `${what}.`, recordValues(r, c), c);
}

/**
 * After a visit: feedback, a check on how they are doing, then the next
 * session of a course or, once it is done, maintenance. Per service, from its
 * latest visit; feedback once per visit day however many services they had.
 */
function visitRows(all: VisitIn[], c: Ctx): Draft[] {
  const groups = new Map<string, VisitIn[]>();
  for (const v of all) {
    const key = v.service.trim().toLowerCase().replace(/\s+/g, " ");
    const g = groups.get(key);
    if (g) g.push(v);
    else groups.set(key, [v]);
  }
  const rows: Draft[] = [];
  const feedbackDays = new Set<string>();
  for (const g of groups.values()) {
    g.sort((a, b) => a.day.localeCompare(b.day) || a.origin.id.localeCompare(b.origin.id));
    const last = g[g.length - 1]!;
    const rule = ruleFor(last.service, c.rules);
    const what = last.service || "their visit";
    const note = rule.isDefault ? " Timing is JENAI's default until the clinic's doctors confirm it." : "";
    const values: Values = { visit_date: last.day, last_visit: last.day, treatment: last.service || null, doctor: last.doctor, branch: last.branch };
    const after = (n: number) => startOf(addDays(last.day, n), c.tz);

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
    const total = last.sessionsTotal ?? rule.courseSessions;
    const done = last.sessionsDone ?? g.length;
    const every = rule.sessionIntervalDays;
    if (total !== null && done < total) {
      if (every) rows.push(callable("next_session", last.origin, after(every), `Session ${done + 1} of ${total} of ${what} is due ${plural(every, "day")} after the last, on ${dateText(last.day)}.${note}`, values, c));
    } else if (rule.maintenanceAfterDays) {
      const had = total !== null ? `Finished the course of ${what}` : `Had ${what}`;
      rows.push(callable("maintenance", last.origin, after(rule.maintenanceAfterDays), `${had} on ${dateText(last.day)}; maintenance is due every ${plural(rule.maintenanceAfterDays, "day")}.${note}`, values, c));
    } else if (total === null && every) {
      // Sessions with no set number (a drip, pigmentation): the next one, every interval.
      rows.push(callable("next_session", last.origin, after(every), `Had ${what} on ${dateText(last.day)}; sessions are due every ${plural(every, "day")}.${note}`, values, c));
    }
  }
  return rows;
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

// ---------------------------------------------------------------- one client

export interface ReplanResult {
  /** People planned: one per number, plus one per record with no usable number. */
  people: number;
  rows: number;
  /** Rows from an earlier plan that no longer apply, removed. */
  removed: number;
  byVerdict: Record<PlannedCallVerdict, number>;
  byJourney: Partial<Record<PlanJourney, Partial<Record<PlannedCallVerdict, number>>>>;
}

const CRM_NAMES: Record<string, string> = { zoho_crm: "Zoho", salesforce: "Salesforce", hubspot: "HubSpot", leadsquared: "LeadSquared", google_sheets: "their sheet" };
/** Rows per insert statement. */
const CHUNK = 500;

/**
 * Plans everyone in one client's records again and stores it in
 * planned_calls: rows that still apply are updated in place (same id),
 * rows for records, visits or calls that no longer apply are removed.
 * Reads crm_records (not deleted), visits, do-not-call entries, the last
 * call with each number, plan settings and treatment rules.
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
    const crmOf = new Map((await tx.select({ id: integrations.id, kind: integrations.kind }).from(integrations)).map((i) => [i.id, CRM_NAMES[i.kind] ?? "their CRM"]));
    const records = await tx.select().from(crmRecords).where(isNull(crmRecords.deletedAt));
    const taken = await tx.select().from(visits);
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
      if (!p) people.set(key, (p = { phone, records: [], visits: [], suppressions: [], lastCallAt: null, contactId: phone ? (contactOf.get(phone) ?? null) : null, programs }));
      return p;
    };
    for (const r of records) personFor(r.phoneE164 ?? `record:${r.id}`, r.phoneE164).records.push({ ...r, crm: crmOf.get(r.integrationId) ?? "their CRM" });
    for (const v of taken) {
      const p = personFor(v.phoneE164, v.phoneE164);
      p.visits.push(v);
      p.contactId ??= v.contactId;
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
    return { people: people.size, rows: list.length, removed: removed.length, byVerdict, byJourney };
  });
}
