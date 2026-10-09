/**
 * Every call program the catalogue command loads (packages/db/seed-data/programs),
 * checked the way setting one up and publishing it would check it, so a script
 * that would read a blank or a raw {{placeholder}} to a patient never ships.
 * Pure: reads the files, no database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { ProgramDefaults, ProgramExtraction, ProgramField, ProgramOutcome, ProgramRedteamCase, ProgramRequirements, ProgramVariable } from "@jenai/db";
import { ALWAYS_ALLOWED, lintVersion } from "@jenai/voice";
import { PLAN_JOURNEYS, PROGRAM_PURPOSE, PROGRAM_VARIABLES } from "./care-plan";
import { fillFields } from "./programs";
import { ALL_CASES } from "./safety/cases";

interface ProgramFile {
  key: string;
  version: number;
  vertical: string;
  name: string;
  summary: string;
  direction?: string;
  purpose: string;
  goal: string;
  task_prompt: string;
  opening: string;
  variables: ProgramVariable[];
  client_fields: ProgramField[];
  extraction: ProgramExtraction[];
  outcomes: ProgramOutcome[];
  defaults: ProgramDefaults;
  requirements: ProgramRequirements;
  compliance_note: string;
  redteam_cases: ProgramRedteamCase[];
}

const dir = new URL("../../db/seed-data/programs/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const text = (f: string) => readFileSync(new URL(f, dir), "utf8");
const all = files.map((file) => ({ file, p: JSON.parse(text(file)) as ProgramFile }));
const latest = (key: string) => all.filter((x) => x.p.key === key).sort((a, b) => b.p.version - a.p.version)[0]?.p;

/**
 * Placeholders the voice engine fills, as it parses them: a missing value
 * reads as blank, unless the placeholder carries a fallback (`| fallback:x`).
 */
function placeholders(s: string): Array<{ name: string; fallback: boolean }> {
  return [...s.matchAll(/\{\{\s*([^|\s}]+)(?:\s*\|\s*([^:}]+)(?::([^}]+))?)?\s*\}\}/g)].map((m) => ({ name: m[1]!.toLowerCase(), fallback: m[2] !== undefined }));
}

/** What setting the program up would make of it, with each client field answered by its example. */
function setUp(p: ProgramFile) {
  const values = Object.fromEntries(p.client_fields.map((f) => [f.name, f.example ?? ""]));
  const opening = fillFields(p.opening, values, p.variables);
  const taskPrompt = fillFields(p.task_prompt, values, p.variables);
  const name = values.clinic_name ?? values.office_name ?? values.business_name ?? values.department_name ?? p.name;
  const greeting = p.direction === "inbound" ? opening : `${name}. I am the AI assistant. How can I help you?`;
  return { values, opening, taskPrompt, greeting };
}
const FACTS = "YOU ARE the assistant at this office. Timings Monday to Saturday, 10 AM to 7 PM. Address: Road No 1, Hyderabad.";

describe.each(all)("call program $file", ({ file, p }) => {
  it("is named after its key and version, and has everything the catalogue stores", () => {
    expect(file).toBe(`${p.key}.v${p.version}.json`);
    for (const k of ["key", "vertical", "name", "summary", "goal", "task_prompt", "opening", "compliance_note"] as const) expect(p[k].trim(), k).not.toBe("");
    expect(["service", "transactional", "promotional"]).toContain(p.purpose);
    expect(["inbound", "outbound", undefined]).toContain(p.direction);
  });

  it("fills every placeholder, once from the client or on each call, and says it is an AI", () => {
    const perCall = new Set<string>([...ALWAYS_ALLOWED, ...p.variables.map((v) => v.name)]);
    const optional = new Set(p.variables.filter((v) => !v.required && v.name !== "caller_name").map((v) => v.name));
    const clientField = new Set(p.client_fields.map((f) => f.name));
    for (const ph of placeholders(`${p.opening}\n${p.task_prompt}`)) {
      // A placeholder with a fallback may come from the engine itself (a pre-call lookup); a bare one must be declared.
      if (!ph.fallback) expect(perCall.has(ph.name) || clientField.has(ph.name), `{{${ph.name}}} is filled by nothing`).toBe(true);
      // A value the dialer may not have would otherwise read as a blank.
      if (optional.has(ph.name)) expect(ph.fallback, `optional {{${ph.name}}} has no fallback`).toBe(true);
    }
    for (const f of p.client_fields.filter((x) => x.required)) expect(f.example?.trim(), `${f.name} needs an example`).toBeTruthy();
    const s = setUp(p);
    const errors = lintVersion({ greeting: s.greeting, facts: FACTS, outboundOpening: s.opening, taskPrompt: s.taskPrompt }, p.variables.map((v) => v.name)).filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("declares its variables, fields, answers and outcomes once each, with a lead stage for every outcome", () => {
    const unique = (xs: string[]) => expect(new Set(xs).size).toBe(xs.length);
    unique(p.variables.map((v) => v.name));
    unique(p.client_fields.map((f) => f.name));
    unique(p.extraction.map((x) => x.name));
    unique(p.outcomes.map((o) => o.key));
    for (const v of p.variables) expect(["text", "number", "date", "money"]).toContain(v.type);
    // A client field named like a per-call variable would never be filled in.
    expect(p.client_fields.filter((f) => p.variables.some((v) => v.name === f.name))).toEqual([]);
    for (const x of p.extraction) expect(x.prompt.trim()).not.toBe("");
    for (const o of p.outcomes) expect(["new", "contacted", "callback", "booked", "won", "lost"]).toContain(o.stage);
  });

  it("has calling hours and limits a campaign can inherit, and the legal class its purpose needs", () => {
    const w = p.defaults.windows!;
    expect(w.days.length).toBeGreaterThan(0);
    for (const d of w.days) expect(d >= 0 && d <= 6).toBe(true);
    expect(w.start).toMatch(/^\d\d:\d\d$/);
    expect(w.end).toMatch(/^\d\d:\d\d$/);
    expect(w.start < w.end).toBe(true);
    for (const n of [p.defaults.maxAttempts, p.defaults.dailyCapPerContact, p.defaults.maxConcurrency]) expect(Number.isInteger(n) && n! > 0).toBe(true);
    expect(["series_140", "normal", "any"]).toContain(p.requirements.callerIdSeries);
    expect(["explicit", "existing_relationship", "statutory"]).toContain(p.requirements.consent);
    expect(p.requirements.records?.length).toBeGreaterThan(0);
    if (p.purpose === "promotional") expect([p.requirements.callerIdSeries, p.requirements.consent]).toEqual(["series_140", "explicit"]);
  });

  it("brings its own safety cases, each with a pass and a fail, none shadowing the platform's", () => {
    expect(p.redteam_cases.length).toBeGreaterThan(0);
    const ids = p.redteam_cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const platform = new Set(ALL_CASES.map((c) => c.id));
    for (const c of p.redteam_cases) {
      expect(platform.has(c.id), c.id).toBe(false);
      expect(["critical", "high", "medium"]).toContain(c.severity);
      expect(c.risk.trim()).not.toBe("");
      expect(c.turns.length).toBeGreaterThan(0);
      expect(c.rubric).toMatch(/PASS if[\s\S]+FAIL if/);
    }
  });

  it("has no em dash anywhere", () => {
    expect(text(file)).not.toContain("\u2014");
  });
});

describe("the call plan's programs", () => {
  it("each program the plan calls with is in the catalogue, with the purpose and the variables its script has", () => {
    const keys = new Set([...Object.values(PLAN_JOURNEYS).map((j) => j.program).filter(Boolean), ...Object.keys(PROGRAM_PURPOSE), ...Object.keys(PROGRAM_VARIABLES)]);
    for (const key of keys) {
      const p = latest(key);
      expect(p, `${key} has no program file`).toBeDefined();
      expect(PROGRAM_PURPOSE[key], key).toBe(p!.purpose);
      expect([...(PROGRAM_VARIABLES[key] ?? [])].sort(), key).toEqual(p!.variables.map((v) => v.name).sort());
    }
  });
});

describe("course check-in program", () => {
  const p = latest("clinic.course_checkin")!;

  it("is a service call to the clinic's own patient, from a normal number, in the clinic's calling hours", () => {
    expect([p.vertical, p.direction, p.purpose]).toEqual(["health", "outbound", "service"]);
    expect(p.requirements.callerIdSeries).toBe("normal");
    expect(p.requirements.consent).toBe("existing_relationship");
    expect(p.defaults).toEqual({ windows: { days: [1, 2, 3, 4, 5, 6], start: "11:00", end: "19:30" }, maxAttempts: 2, dailyCapPerContact: 1, maxConcurrency: 3 });
  });

  it("carries what one call between sittings needs, and records what the owner wants to know", () => {
    expect(p.variables.map((v) => [v.name, v.required])).toEqual([
      ["caller_name", true],
      ["treatment", true],
      ["last_visit", true],
      ["sitting_number", false],
      ["sessions_left", false],
      ["next_due", false],
      ["book_before", false],
      ["doctor", false],
      ["branch", false],
    ]);
    expect(p.variables.filter((v) => v.type === "date").map((v) => v.name)).toEqual(["last_visit", "next_due", "book_before"]);
    expect(p.client_fields.map((f) => f.name)).toEqual(["clinic_name", "clinic_number", "complaint_route"]);
    expect(p.extraction.map((x) => x.name)).toEqual(["how_feeling", "difference_noticed", "concern_reported", "complication_reported", "stopped_reason", "next_sitting", "booked_elsewhere_for", "wants_callback"]);
    expect(Object.fromEntries(p.outcomes.map((o) => [o.key, o.stage]))).toEqual({
      next_booked: "won",
      already_booked: "booked",
      doing_well_not_booked: "callback",
      concern_callback: "callback",
      medical_issue: "callback",
      stopped_course: "lost",
      refused: "contacted",
      do_not_call: "lost",
      wrong_number: "lost",
    });
    // Health answers stay in JENAI: only the booking, a callback request and the no-health outcomes may reach a CRM.
    expect(p.extraction.filter((x) => x.shareable).map((x) => x.name)).toEqual(["next_sitting", "booked_elsewhere_for", "wants_callback"]);
    expect(p.outcomes.filter((o) => o.shareable).map((o) => o.key)).toEqual(["next_booked", "already_booked", "refused", "do_not_call", "wrong_number"]);
  });

  it("never names the treatment before it knows who answered", () => {
    expect(p.opening).not.toContain("{{treatment}}");
    expect(p.opening).toMatch(/AI assistant/);
    expect(p.task_prompt).toMatch(/NOT the patient[^\n]*Never say the treatment/);
  });

  it("fills the clinic's answers once and leaves the patient's for each call", () => {
    const s = setUp(p);
    expect(s.taskPrompt).toContain("89777 59580");
    expect(s.taskPrompt).toContain("the branch manager will call you back today");
    expect(s.taskPrompt).toContain("{{treatment}}");
    expect(s.taskPrompt).toContain("{{last_visit}}");
    expect(s.taskPrompt).toContain("{{next_due | fallback:not known}}");
    expect(s.taskPrompt).toContain("{{book_before | fallback:none}}");
    expect(s.opening).toContain("Zennara Skin and Hair Clinic");
  });

  it("presents what JENAI holds as possibly incomplete, and never books a sitting twice", () => {
    expect(p.task_prompt).toMatch(/WHAT JENAI HAS ON RECORD, which may be incomplete/);
    expect(p.task_prompt).not.toMatch(/CLINIC'S RECORDS SAY/);
    // Which sitting, or how many are left, only when asked; else the front desk confirms it.
    expect(p.task_prompt).toMatch(/Never tell them which sitting this is or how many are left unless they ask/);
    // A count JENAI could not know: ask before offering, and a finished course gets no offer.
    expect(p.task_prompt).toMatch(/If the records do not say which sitting the last one was, first ask/);
    expect(p.task_prompt).toMatch(/If they say the course is finished, do not offer a sitting/);
    expect(p.task_prompt).toMatch(/already booked, do not book it again and do not read anything back as a new booking/);
    // A package about to end: booked by its last day, about their own sittings only.
    expect(p.task_prompt).toMatch(/If book on or before is not none, the day must be on or before it/);
    expect(p.task_prompt).toMatch(/the next one is due\./);
  });

  it("is checked against a complication, upselling, a family member and a demand for a promise", () => {
    expect(p.redteam_cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(["checkin_complication", "checkin_upsell", "checkin_family_probe", "checkin_result_promise", "checkin_already_booked", "checkin_sittings_left", "checkin_course_finished"]),
    );
    expect(p.redteam_cases.find((c) => c.id === "checkin_already_booked")!.rubric).toMatch(/FAIL if it runs the booking steps, reads back a day and time as a new booking/);
    const complication = p.redteam_cases.find((c) => c.id === "checkin_complication")!;
    expect(complication.severity).toBe("critical");
    expect(complication.turns[0]).toMatch(/blistering and swollen/);
  });
});

describe("the outbound clinic base (template.clinic_outbound.v1)", () => {
  // Pinned after the Zennara demo calls of 9 Oct 2026, where every call type turned into a
  // long consultation: medical history, care tips, the caller's number asked for again.
  const t = JSON.parse(readFileSync(new URL("../../db/seed-data/template.clinic_outbound.v1.json", import.meta.url), "utf8")) as { key: string; version: number; base_prompt: string; end_prompt: string };
  const b = t.base_prompt;

  it("is the base every outbound clinic program gets", async () => {
    const { CLINIC_OUTBOUND_TEMPLATE } = await import("./agents");
    expect(CLINIC_OUTBOUND_TEMPLATE).toEqual({ key: t.key, version: t.version });
  });
  it("keeps every reply short: one sentence, one question, then listen", () => {
    expect(b).toMatch(/ONE short sentence, at most about 15 words, then ONE question, then STOP and listen/);
    expect(b).toMatch(/Never two questions in one reply/);
  });
  it("does one job and never turns the call into a consultation or gives advice", () => {
    expect(b).toMatch(/Never turn the call into a consultation/);
    expect(b).toMatch(/Never give care tips, home remedies, skincare routines or any advice/);
  });
  it("never asks for the number it is calling", () => {
    expect(b).toMatch(/NEVER ask for their number/);
  });
  it("sends any side effect to the doctor without advice", () => {
    expect(b).toMatch(/I will ask the doctor to\s+call you today/);
    expect(b).toMatch(/never suggest a cream, compress or remedy/);
  });
  it("speaks Tenglish and Hinglish, with days, dates and times in English", () => {
    expect(b).toMatch(/A Telugu turn gets TENGLISH/);
    expect(b).toMatch(/A Hindi turn gets HINGLISH/);
    expect(b).toMatch(/Days, dates and times ALWAYS in English/);
    expect(b).toMatch(/If most of their words are Hindi, even with some\s+garbled ones, it IS a Hindi turn/);
  });
  it("never claims a booking, a price or a confirmation message it cannot stand behind", () => {
    expect(b).toMatch(/Say "booked" ONLY after a clear yes/);
    expect(b).toMatch(/Never invent a price, a doctor's name, an address, a timing or a WhatsApp or SMS confirmation/);
  });
  it("has no em dashes", () => {
    expect(`${b}${t.end_prompt}`).not.toMatch(/—/);
  });
});
