/**
 * The visit list: the services people actually took, exported as CSV from a
 * clinic's or salon's own front desk or billing software and uploaded here.
 * importVisits() stores one visits row per person, service and day, keeps a
 * contact for every number, then plans everyone's calls again, so a visit
 * turns into its feedback call, result check or next session.
 *
 * Every vendor's export looks different, so columns are found by name (any
 * case or punctuation, with the usual synonyms), dates are read day first as
 * India writes them, and a row that cannot be used is reported by its row
 * number with a plain reason. Nothing from a row (name, number, service, date)
 * is ever logged or repeated in a reason.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit, branches, callPlanSettings, contacts, organizations, withTenant, type AuditInput } from "@jenai/db";
import { toE164 } from "@jenai/voice";
import { replanTenant, type ReplanResult } from "./care-plan";
import { localParts } from "./dialer/time";

/** Largest file taken, in bytes. A bigger export is split by date. */
export const VISIT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Most rows taken from one file. */
export const VISIT_IMPORT_MAX_ROWS = 20_000;
/** An older visit prompts no call, and is more likely a mistyped year. */
const MAX_AGE_YEARS = 3;
/** Title lines some exports put above the column names. */
const HEADER_SEARCH_ROWS = 20;
/** Rows per write statement. */
const CHUNK = 1000;

/** A file that cannot be imported at all, with a reason the clinic can act on. */
export class VisitImportError extends Error {
  override name = "VisitImportError";
}

// ---------------------------------------------------------------- reading the file

/**
 * The file's text. Excel saves "CSV UTF-8", plain "CSV" in the Windows code
 * page, or "Unicode text" in UTF-16; all three come out readable.
 */
export function decodeVisitFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * RFC 4180 CSV: quoted fields, "" for a quote inside one, separators and line
 * breaks inside quotes, CRLF or LF, a UTF-8 byte-order mark. The separator is
 * whichever of comma, semicolon or tab the first lines use most (Excel writes
 * semicolons in some locales and tabs in "Unicode text"). A blank line stays
 * a row, so row numbers match what a spreadsheet shows.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sep = separatorOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (ch === '"' && !started) {
      quoted = started = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
      started = false;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      [row, field, started] = [[], "", false];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += ch;
      started = true;
    }
  }
  if (started || row.length) rows.push([...row, field]);
  return rows;
}

function separatorOf(text: string): string {
  const head = text.slice(0, 8192);
  const count = (c: string) => head.split(c).length;
  return [",", ";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best));
}

// ---------------------------------------------------------------- columns

export type VisitField = "phone" | "service" | "date" | "name" | "doctor" | "branch" | "sessions_done" | "sessions_total";

/**
 * Column names each field is read from, best first: with both "Visit Date"
 * and "Date", the visit date is used. Compared ignoring case, spaces and
 * punctuation, so "Mobile No." is "mobile no". A client adds their own
 * export's names in call_plan_settings.settings.visitColumns.
 */
export const VISIT_COLUMNS: Record<VisitField, readonly string[]> = {
  phone: ["mobile", "phone", "mobile number", "phone number", "contact", "guest mobile", "mobile no", "phone no", "contact number", "contact no", "patient mobile", "customer mobile", "client mobile"],
  service: ["service", "treatment", "service name", "item", "procedure", "package", "treatment name", "services", "item name"],
  date: ["visit date", "date", "invoice date", "appointment date", "service date", "bill date", "date of visit", "treatment date", "billing date"],
  name: ["name", "patient name", "guest name", "client name", "customer name", "patient", "full name", "guest", "customer", "client"],
  doctor: ["doctor", "provider", "therapist", "consultant", "employee", "doctor name", "staff", "stylist"],
  branch: ["branch", "centre", "center", "location", "clinic", "branch name", "centre name", "center name", "outlet"],
  sessions_done: ["sessions done", "session no", "session number", "sitting", "session", "sitting no", "sessions completed"],
  sessions_total: ["sessions total", "total sessions", "package sessions", "no of sessions", "total sittings", "no of sittings"],
};
const FIELDS = Object.keys(VISIT_COLUMNS) as VisitField[];
const REQUIRED: VisitField[] = ["phone", "service", "date"];
const FIELD_TEXT: Record<VisitField, string> = {
  phone: "phone number",
  service: "service",
  date: "visit date",
  name: "name",
  doctor: "doctor",
  branch: "branch",
  sessions_done: "sessions done",
  sessions_total: "total sessions",
};

/** Names typed the way people type them: any case, spacing or punctuation. */
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The client's own column names (visitColumns), tried before the defaults. A malformed setting is ignored. */
export function visitColumnsOf(raw: unknown): Record<VisitField, readonly string[]> {
  const own = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...VISIT_COLUMNS };
  for (const f of FIELDS) {
    const v = own[f];
    if (Array.isArray(v)) out[f] = [...v.filter((x): x is string => typeof x === "string" && !!norm(x)), ...VISIT_COLUMNS[f]];
  }
  return out;
}

export interface VisitColumns {
  /** Index of the row holding the column names (0 is the file's first row). */
  header: number;
  /** Columns per field, best first. The phone falls back to the next column when one is empty. */
  at: Partial<Record<VisitField, number[]>>;
  /** The column name each field is read from, as the file writes it. */
  names: Partial<Record<VisitField, string>>;
}

/**
 * Finds the row of column names among the first rows (some exports put a
 * report title above it) and which column holds each field. Throws when no
 * row names a phone, service and date column, saying which are missing.
 */
export function findColumns(rows: string[][], names: Record<VisitField, readonly string[]> = VISIT_COLUMNS): VisitColumns {
  let best: VisitColumns | null = null;
  for (let r = 0; r < Math.min(rows.length, HEADER_SEARCH_ROWS); r++) {
    const cells = rows[r]!.map(norm);
    const used = new Set<number>();
    const found: VisitColumns = { header: r, at: {}, names: {} };
    for (const f of FIELDS) {
      const wanted = names[f].map(norm);
      const cols = cells
        .map((c, i) => ({ i, rank: wanted.indexOf(c) }))
        .filter((x) => x.rank >= 0 && !used.has(x.i))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.i);
      if (!cols.length) continue;
      const take = f === "phone" ? cols : cols.slice(0, 1);
      take.forEach((i) => used.add(i));
      found.at[f] = take;
      found.names[f] = rows[r]![take[0]!]!.trim();
    }
    if (REQUIRED.every((f) => found.at[f])) return found;
    if (!best || Object.keys(found.at).length > Object.keys(best.at).length) best = found;
  }
  const missing = REQUIRED.filter((f) => !best?.at[f]);
  throw new VisitImportError(
    missing.map((f) => `No ${FIELD_TEXT[f]} column was found: name it one of ${names[f].slice(0, 6).map((n) => `"${n}"`).join(", ")}.`).join(" ") +
      ` JENAI looks for the column names in the first ${HEADER_SEARCH_ROWS} rows.`,
  );
}

// ---------------------------------------------------------------- dates

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthOf(word: string): number | null {
  if (word === "sept") return 9;
  if (word.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(word));
  return i < 0 ? null : i + 1;
}

/**
 * A visit day as yyyy-mm-dd, or null. Takes 01/10/2026, 01-10-2026,
 * 01.10.2026, 01/10/26, 2026-10-01, 01-Oct-2026, 1 Oct 2026 and
 * Oct 1, 2026, with or without a time after. Day first whenever the form
 * could be either way, as dates are written in India; a two-digit year is
 * this century.
 */
export function parseVisitDate(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    // The time of day is not needed: the plan works in days.
    .replace(/(?:t|\s)\d{1,2}[:.]\d{2}(?:[:.]\d{2}(?:\.\d+)?)?\s*(?:am|pm)?\s*(?:z|[+-]\d{2}:?\d{2})?$/, "")
    .trim();
  let y: number, m: number | null, d: number;
  let x: RegExpExecArray | null;
  if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [y, m, d] = [+x[1]!, +x[2]!, +x[3]!];
  else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) [d, m, y] = [+x[1]!, +x[2]!, +x[3]!];
  else if ((x = /^(\d{1,2})(?:st|nd|rd|th)?[- ]([a-z]+)\.?[- ](\d{4}|\d{2})$/.exec(s))) [d, m, y] = [+x[1]!, monthOf(x[2]!), +x[3]!];
  else if ((x = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/.exec(s))) [m, d, y] = [monthOf(x[1]!), +x[2]!, +x[3]!];
  else return null;
  if (y < 100) y += 2000;
  if (!m || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- rows

/** One usable row of the file. */
export interface VisitRow {
  /** Row number as a spreadsheet shows it, the column names' row included. */
  row: number;
  phone: string;
  name: string | null;
  service: string;
  visitDate: string;
  doctor: string | null;
  branch: string | null;
  branchId: string | null;
  sessionsDone: number | null;
  sessionsTotal: number | null;
}

export interface VisitReject {
  row: number;
  reason: string;
}

export interface VisitCheck {
  /** Today for the client, yyyy-mm-dd. Later visits are refused. */
  today: string;
  branches?: ReadonlyArray<{ id: string; name: string; code?: string | null }>;
  /** Branches the uploader may add visits for. Left out, every branch. */
  allowedBranchIds?: readonly string[];
}

/** Cells exports use for "nothing here". */
const BLANK = new Set(["", "-", "--", "na", "n/a", "nil", "null", "none", "0000-00-00"]);
const MAX_SERVICE = 200;
const MAX_TEXT = 120;

/** Excel shows a long number it took for a value as 9.8E+09: the digits are gone. */
const EXCEL_ROUNDED = /^\s*\d+(?:\.\d+)?e\+?\d+\s*$/i;

/**
 * One number in E.164. "9848012345.0" is a number a spreadsheet wrote as a
 * decimal. Without a "+", fewer than 10 digits is a typo, not a number abroad.
 */
function phoneOf(cell: string): string | null {
  const c = cell.trim().replace(/\.0+$/, "");
  if (!c.startsWith("+") && c.replace(/\D/g, "").length < 10) return null;
  return toE164(c);
}

function cleanText(v: string | undefined, max = MAX_TEXT): string | null {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return BLANK.has(t.toLowerCase()) ? null : t.slice(0, max);
}

/**
 * Reads every row under the column names into visits or rejections. Pure. A
 * row is refused, with its number and a plain reason, when the number,
 * service or date is missing or unreadable, the date is in the future or
 * more than 3 years ago, or the uploader's role does not cover its branch.
 */
export function readVisitRows(rows: string[][], cols: VisitColumns, check: VisitCheck): { visits: VisitRow[]; rejected: VisitReject[]; rows: number } {
  const [ty, tm, td] = check.today.split("-");
  const oldest = `${Number(ty) - MAX_AGE_YEARS}-${tm}-${td}`;
  const branchOf = branchMatcher(check.branches ?? []);
  const allowed = check.allowedBranchIds ? new Set(check.allowedBranchIds) : null;
  // A role covering every branch there is covers rows that name none.
  const restricted = !!allowed && (check.branches ?? []).some((b) => !allowed.has(b.id));
  const cell = (r: string[], f: VisitField) => {
    const i = cols.at[f]?.[0];
    return i === undefined ? undefined : r[i];
  };

  const out: VisitRow[] = [];
  const rejected: VisitReject[] = [];
  let read = 0;
  for (let n = cols.header + 1; n < rows.length; n++) {
    const r = rows[n]!;
    if (r.every((c) => !c.trim())) continue;
    read++;
    const row = n + 1;
    const no = (reason: string) => rejected.push({ row, reason });

    const phones = (cols.at.phone ?? []).map((i) => r[i] ?? "").filter((c) => !BLANK.has(c.trim().toLowerCase()));
    if (!phones.length) {
      no("No phone number.");
      continue;
    }
    // A cell can hold two numbers ("98480 12345 / 99490 12345"): the first one that reads.
    const phone = phones
      .filter((c) => !EXCEL_ROUNDED.test(c))
      .flatMap((c) => c.split(/[/,;|]|\bor\b/i))
      .map(phoneOf)
      .find(Boolean);
    if (!phone) {
      no(
        phones.some((c) => EXCEL_ROUNDED.test(c))
          ? "Excel has rounded the phone number off (it shows like 9.8E+09). Format the column as Text in Excel and export again."
          : "The phone number is not one JENAI can read.",
      );
      continue;
    }
    const service = cleanText(cell(r, "service"), Infinity);
    if (!service) {
      no("No service or treatment.");
      continue;
    }
    if (service.length > MAX_SERVICE) {
      no(`The service name is longer than ${MAX_SERVICE} characters.`);
      continue;
    }
    const dateText = cleanText(cell(r, "date"));
    if (!dateText) {
      no("No visit date.");
      continue;
    }
    const visitDate = parseVisitDate(dateText);
    if (!visitDate) {
      no("The visit date is not a date JENAI can read. Write it day first, like 01/10/2026 or 1 Oct 2026.");
      continue;
    }
    if (visitDate > check.today) {
      no("The visit date is in the future. The list is for visits that have happened.");
      continue;
    }
    if (visitDate < oldest) {
      no(`The visit date is more than ${MAX_AGE_YEARS} years ago.`);
      continue;
    }
    const sessions = sessionsOf(cleanText(cell(r, "sessions_done")), cleanText(cell(r, "sessions_total")));
    if (typeof sessions === "string") {
      no(sessions);
      continue;
    }
    const branch = cleanText(cell(r, "branch"));
    const branchId = branchOf(branch);
    if (restricted && !(branchId && allowed!.has(branchId))) {
      no(branch ? "This row is for a branch your role does not cover." : "This row names no branch, and your role covers only some branches.");
      continue;
    }
    out.push({ row, phone, name: cleanText(cell(r, "name")), service, visitDate, doctor: cleanText(cell(r, "doctor")), branch, branchId, ...sessions });
  }
  return { visits: out, rejected, rows: read };
}

/** "3", "Session 3", "3/6" or "3 of 6" done; "6" in all. A message when one is there but not a count. */
function sessionsOf(done: string | null, total: string | null): { sessionsDone: number | null; sessionsTotal: number | null } | string {
  let sessionsDone: number | null = null;
  let sessionsTotal: number | null = null;
  if (done) {
    const both = /(\d+)\s*(?:\/|of)\s*(\d+)/i.exec(done);
    const one = /\d+/.exec(done);
    if (!one) return "Sessions done is not a number.";
    sessionsDone = Number(both ? both[1] : one[0]);
    if (both) sessionsTotal = Number(both[2]);
  }
  if (total) {
    const t = /\d+/.exec(total);
    if (!t) return "Total sessions is not a number.";
    sessionsTotal = Number(t[0]);
  }
  if (sessionsTotal !== null && sessionsTotal < 1) return "Total sessions has to be 1 or more.";
  if ((sessionsDone ?? 0) > 1000 || (sessionsTotal ?? 0) > 1000) return "The session count is too large to be right.";
  return { sessionsDone, sessionsTotal };
}

/**
 * The client's branch a name in the file (or a centre in their connected
 * system) means: the same name or code, or failing that the one branch whose
 * name it contains ("Zennara Kondapur" is the Kondapur branch). Null when
 * none or several match.
 */
export function branchMatcher(list: ReadonlyArray<{ id: string; name: string; code?: string | null }>) {
  const seen = new Map<string, string | null>();
  return (text: string | null): string | null => {
    const k = norm(text);
    if (!k) return null;
    if (seen.has(k)) return seen.get(k)!;
    let hit = list.filter((b) => norm(b.name) === k || (b.code && norm(b.code) === k));
    if (!hit.length && k.length >= 3) hit = list.filter((b) => norm(b.name).length >= 3 && (k.includes(norm(b.name)) || norm(b.name).includes(k)));
    const id = hit.length === 1 ? hit[0]!.id : null;
    seen.set(k, id);
    return id;
  };
}

// ---------------------------------------------------------------- storing

export type VisitSource = "upload" | "api" | "manual";

export interface VisitImportOptions {
  /** How the visits arrived; stored on each one. */
  source?: VisitSource;
  /** The user who uploaded, for the audit log. Null from the command line. */
  uploadedBy?: string | null;
  /** The rest of the audit entry, from the web app: support sessions, address, browser. */
  audit?: Pick<AuditInput, "impersonatorUserId" | "via" | "ip" | "userAgent">;
  /** Branches the uploader's role covers. Left out, every branch. */
  branchIds?: readonly string[];
  now?: Date;
}

export interface VisitImportResult {
  /** Rows read under the column names, blank lines left out. */
  rows: number;
  /** New visits stored. */
  added: number;
  /** Visits already stored that this file filled in or changed. */
  updated: number;
  /** Visits already stored exactly as the file has them. */
  unchanged: number;
  /** Rows repeating a person, service and day earlier in the same file: one visit. */
  repeated: number;
  rejected: VisitReject[];
  /** Which column each field was read from, as the file names it. */
  columns: Partial<Record<VisitField, string>>;
  /** Stored on every visit this upload added or changed, so it can be told apart later. */
  batch: string;
  /** The call plan, made again with these visits in it. */
  plan: ReplanResult;
}

/**
 * Imports a visit list (CSV text) for one client: every usable row becomes a
 * visit (one per person, service and day, whatever the capitalisation), every
 * number a contact (source visit_list; a name is filled in only where the
 * contact has none), then the call plan is made again. Uploading the same file
 * twice changes nothing. The audit entry holds counts only.
 *
 * Throws VisitImportError for a file that cannot be read at all: too many
 * rows, or no phone, service or date column.
 */
export async function importVisits(tenantId: string, csvText: string, opts: VisitImportOptions = {}): Promise<VisitImportResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? "upload";
  const table = parseCsv(csvText);
  const filled = (r: string[]) => r.some((c) => c.trim());
  if (!table.some(filled)) throw new VisitImportError("The file is empty.");

  const setup = await withTenant(tenantId, async (tx) => {
    const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, tenantId));
    const [own] = await tx.select({ settings: callPlanSettings.settings }).from(callPlanSettings).where(eq(callPlanSettings.tenantId, tenantId));
    const list = await tx.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches);
    return { tz: org?.timezone ?? "Asia/Kolkata", columns: (own?.settings as Record<string, unknown> | undefined)?.visitColumns, branches: list };
  });
  const cols = findColumns(table, visitColumnsOf(setup.columns));
  if (table.slice(cols.header + 1).filter(filled).length > VISIT_IMPORT_MAX_ROWS) throw new VisitImportError(`The file has more than ${VISIT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} rows. Split it into smaller files by date.`);
  const p = localParts(now, setup.tz);
  const today = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const read = readVisitRows(table, cols, { today, branches: setup.branches, allowedBranchIds: opts.branchIds });

  // The same visit twice in one file is one visit, spelt as it first appears;
  // a later row fills in or changes the rest.
  const once = new Map<string, VisitRow>();
  for (const v of read.visits) {
    const key = `${v.phone}\u0000${v.service.toLowerCase()}\u0000${v.visitDate}`;
    const had = once.get(key);
    once.set(key, had ? { ...had, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)), service: had.service } : v);
  }
  const list = [...once.values()];
  const batch = randomUUID();

  const counts = await withTenant(tenantId, async (tx) => {
    // Each person's contact, named after their latest visit that gives a name.
    const people = new Map<string, { name: string | null; branchId: string | null; day: string }>();
    for (const v of list) {
      const p = people.get(v.phone);
      if (!p) people.set(v.phone, { name: v.name, branchId: v.branchId, day: v.visitDate });
      else if (v.visitDate >= p.day) people.set(v.phone, { name: v.name ?? p.name, branchId: v.branchId ?? p.branchId, day: v.visitDate });
      else people.set(v.phone, { ...p, name: p.name ?? v.name, branchId: p.branchId ?? v.branchId });
    }
    const phones = [...people.keys()];
    const contactOf = new Map<string, string>();
    for (let n = 0; n < phones.length; n += CHUNK) {
      const part = phones.slice(n, n + CHUNK);
      await tx
        .insert(contacts)
        .values(part.map((phone) => ({ tenantId, phoneE164: phone, name: people.get(phone)!.name, branchId: people.get(phone)!.branchId, source: "visit_list", tags: [] })))
        .onConflictDoUpdate({
          target: [contacts.tenantId, contacts.phoneE164],
          set: { name: sql`excluded.name`, updatedAt: sql`now()` },
          setWhere: sql`coalesce(${contacts.name}, '') = '' and excluded.name is not null`,
        });
      for (const c of await tx.select({ id: contacts.id, phone: contacts.phoneE164 }).from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.phoneE164, part))))
        contactOf.set(c.phone, c.id);
    }

    let added = 0;
    let updated = 0;
    for (let n = 0; n < list.length; n += CHUNK) {
      const part = list.slice(n, n + CHUNK).map((v) => ({
        contact_id: contactOf.get(v.phone) ?? null,
        phone_e164: v.phone,
        name: v.name,
        service: v.service,
        visit_date: v.visitDate,
        doctor: v.doctor,
        branch: v.branch,
        branch_id: v.branchId,
        sessions_done: v.sessionsDone,
        sessions_total: v.sessionsTotal,
      }));
      // visits_once is on lower(service), an expression Drizzle's upsert cannot name, hence plain SQL.
      // A value the file leaves empty keeps the one stored; a visit the file changes nothing in is not written.
      const res = await tx.execute<{ inserted: boolean }>(sql`
        insert into visits (tenant_id, contact_id, phone_e164, name, service, visit_date, doctor, branch, branch_id, sessions_done, sessions_total, source, batch)
        select ${tenantId}, v.contact_id, v.phone_e164, v.name, v.service, v.visit_date, v.doctor, v.branch, v.branch_id, v.sessions_done, v.sessions_total, ${source}, ${batch}
        from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as v(contact_id uuid, phone_e164 text, name text, service text, visit_date date, doctor text, branch text, branch_id uuid, sessions_done int, sessions_total int)
        on conflict (tenant_id, phone_e164, lower(service), visit_date) do update set
          contact_id = coalesce(excluded.contact_id, visits.contact_id),
          name = coalesce(excluded.name, visits.name),
          doctor = coalesce(excluded.doctor, visits.doctor),
          branch = coalesce(excluded.branch, visits.branch),
          branch_id = coalesce(excluded.branch_id, visits.branch_id),
          sessions_done = coalesce(excluded.sessions_done, visits.sessions_done),
          sessions_total = coalesce(excluded.sessions_total, visits.sessions_total),
          batch = excluded.batch,
          updated_at = now()
        where (coalesce(excluded.contact_id, visits.contact_id), coalesce(excluded.name, visits.name), coalesce(excluded.doctor, visits.doctor),
               coalesce(excluded.branch, visits.branch), coalesce(excluded.branch_id, visits.branch_id),
               coalesce(excluded.sessions_done, visits.sessions_done), coalesce(excluded.sessions_total, visits.sessions_total))
          is distinct from (visits.contact_id, visits.name, visits.doctor, visits.branch, visits.branch_id, visits.sessions_done, visits.sessions_total)
        returning (xmax = 0) as inserted`);
      for (const r of res) {
        if (r.inserted) added++;
        else updated++;
      }
    }
    const c = { added, updated, unchanged: list.length - added - updated, repeated: read.visits.length - list.length, rejected: read.rejected.length };
    await audit(tx, {
      tenantId,
      actorUserId: opts.uploadedBy ?? null,
      impersonatorUserId: opts.audit?.impersonatorUserId ?? null,
      via: opts.audit?.via ?? (opts.uploadedBy ? "user" : "system"),
      ip: opts.audit?.ip ?? null,
      userAgent: opts.audit?.userAgent ?? null,
      action: "visits.imported",
      targetType: "visit_batch",
      targetId: batch,
      summary: `Visit list uploaded: ${c.added} added, ${c.updated} updated, ${c.unchanged} unchanged, ${c.rejected} rows refused`,
      diff: { rows: read.rows, ...c },
    });
    return c;
  });

  const plan = await replanTenant(tenantId, { now });
  return { rows: read.rows, added: counts.added, updated: counts.updated, unchanged: counts.unchanged, repeated: counts.repeated, rejected: read.rejected, columns: cols.names, batch, plan };
}
