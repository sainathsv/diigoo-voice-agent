/**
 * The visit list upload: reading any clinic's CSV export, refusing rows with
 * a plain reason, storing visits and contacts once however often the file is
 * uploaded, and the plan that follows. The last part runs against the local
 * database (`pnpm db:migrate` first).
 *
 * Times are India's. 1 Oct 2026 is a Thursday.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { auditEvents, branches, contacts, organizations, plannedCalls, platformDb, visits, withTenant } from "@jenai/db";
import {
  VISIT_IMPORT_MAX_ROWS,
  VisitImportError,
  VisitRemovalError,
  decodeVisitFile,
  eraseNumber,
  findColumns,
  importVisits,
  parseCsv,
  parseVisitDate,
  readVisitRows,
  removeVisitUpload,
  visitColumnsOf,
  type VisitColumns,
} from "./visits-import";

const NOW = new Date("2026-10-01T12:00:00+05:30");
const TODAY = "2026-10-01";

describe("reading CSV", () => {
  it("handles quotes, quotes inside quotes, separators and line breaks inside quotes", () => {
    const text = 'a,b,c\r\n"x, y","say ""hi""","two\r\nlines"\r\n,,\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\r\nlines"],
      ["", "", ""],
    ]);
  });

  it("drops the byte-order mark, takes LF or CRLF, and keeps a last line with no line break", () => {
    expect(parseCsv("﻿phone,service\n1,a\r\n2,b")).toEqual([
      ["phone", "service"],
      ["1", "a"],
      ["2", "b"],
    ]);
  });

  it("keeps blank lines as rows, so row numbers match the spreadsheet", () => {
    expect(parseCsv("h\n\nx\n")).toEqual([["h"], [""], ["x"]]);
  });

  it("reads an empty quoted field and a lone quote mark in the middle of a field", () => {
    expect(parseCsv('"",5" screen,z')).toEqual([["", '5" screen', "z"]]);
  });

  it("reads semicolon and tab separated exports", () => {
    expect(parseCsv("phone;service;date\n1;Peel, deep;01/10/2026")).toEqual([
      ["phone", "service", "date"],
      ["1", "Peel, deep", "01/10/2026"],
    ]);
    expect(parseCsv("phone\tservice\n1\tPeel, deep")).toEqual([
      ["phone", "service"],
      ["1", "Peel, deep"],
    ]);
  });

  it("decodes UTF-8, UTF-16 (Excel's Unicode text) and the Windows code page", () => {
    const utf8 = new TextEncoder().encode("﻿name\nసీత");
    expect(decodeVisitFile(utf8)).toBe("name\nసీత");
    const text = "name\tphone\nసీత\t9848011111";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) utf16.set([text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8], 2 + i * 2);
    expect(decodeVisitFile(utf16)).toBe(text);
    expect(decodeVisitFile(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
  });
});

describe("finding the columns", () => {
  it("knows the usual names, in any case or punctuation", () => {
    const c = findColumns([["Bill Date", "GUEST NAME", "Guest Mobile", "Item", "Therapist", "Outlet", "Sitting", "No. of Sessions"]]);
    expect(c.at).toEqual({ date: [0], name: [1], phone: [2], service: [3], doctor: [4], branch: [5], sessions_done: [6], sessions_total: [7] });
    expect(c.names).toMatchObject({ phone: "Guest Mobile", service: "Item", date: "Bill Date" });
  });

  it("looks past a report title above the column names", () => {
    const c = findColumns([["Services report"], ["From 01/09/2026 to 30/09/2026"], [], ["Patient Name", "Mobile No.", "Treatment", "Visit Date"]]);
    expect(c.header).toBe(3);
    expect(c.at).toMatchObject({ name: [0], phone: [1], service: [2], date: [3] });
  });

  it("prefers the better name, and keeps every phone column to fall back on", () => {
    const c = findColumns([["Date", "Phone", "Service", "Visit Date", "Mobile"]]);
    expect(c.at.date).toEqual([3]);
    expect(c.at.phone).toEqual([4, 1]);
  });

  it("says which required column is missing", () => {
    const fail = () => findColumns([["Name", "Treatment", "Date"]]);
    expect(fail).toThrow(VisitImportError);
    expect(fail).toThrow(/^No phone number column was found: name it one of "mobile", "phone"/);
    expect(fail).not.toThrow(/service column|visit date column/);
  });

  it("takes a client's own column names first", () => {
    const names = visitColumnsOf({ phone: ["Cust Cell"], service: "not a list" });
    const c = findColumns([["Cust Cell", "Service", "Date", "Phone"]], names);
    expect(c.at.phone).toEqual([0, 3]);
    expect(c.at.service).toEqual([1]);
  });
});

describe("visit dates", () => {
  it.each([
    ["01/10/2026", "2026-10-01"],
    ["1/10/2026", "2026-10-01"],
    ["01-10-2026", "2026-10-01"],
    ["01.10.2026", "2026-10-01"],
    ["01/10/26", "2026-10-01"],
    ["2026-10-01", "2026-10-01"],
    ["2026/10/01", "2026-10-01"],
    ["01-Oct-2026", "2026-10-01"],
    ["01-oct-26", "2026-10-01"],
    ["1 Oct 2026", "2026-10-01"],
    ["1st October 2026", "2026-10-01"],
    ["30 Sept 2026", "2026-09-30"],
    ["Oct 1, 2026", "2026-10-01"],
    ["01/10/2026 10:30", "2026-10-01"],
    ["01/10/2026 10:30:15 AM", "2026-10-01"],
    ["2026-10-01T23:30:00+05:30", "2026-10-01"],
    ["29/02/2028", "2028-02-29"],
  ])("reads %s", (raw, day) => expect(parseVisitDate(raw)).toBe(day));

  it("reads an ambiguous date day first", () => {
    expect(parseVisitDate("03/04/2026")).toBe("2026-04-03");
  });

  it.each(["10/25/2026", "31/02/2026", "29/02/2026", "00/10/2026", "Oktober 1 2026", "1 Ma 2026", "yesterday", "46296", "2026-10"])("refuses %s", (raw) =>
    expect(parseVisitDate(raw)).toBeNull(),
  );
});

describe("reading rows", () => {
  const head = ["Name", "Mobile", "Phone", "Service", "Date", "Branch", "Sessions Done", "Total Sessions"];
  const cols: VisitColumns = findColumns([head]);
  const branchList = [
    { id: "b-kdp", name: "Kondapur", code: "KDP" },
    { id: "b-jub", name: "Jubilee Hills", code: null },
  ];
  const read = (rows: string[][], extra: { allowedBranchIds?: string[] } = {}) => readVisitRows([head, ...rows], cols, { today: TODAY, branches: branchList, ...extra });

  it("refuses unusable rows by row number, with a reason that repeats nothing from the row", () => {
    const rows = [
      ["Anitha", "", "", "Peel", "30/09/2026"],
      ["Bhavana", "12345", "", "Peel", "30/09/2026"],
      ["Chitra", "9848011111", "", "", "30/09/2026"],
      ["Divya", "9848011111", "", "Peel", ""],
      ["Esha", "9848011111", "", "Peel", "31/09/2026"],
      ["Fatima", "9848011111", "", "Peel", "02/10/2026"],
      ["Gita", "9848011111", "", "Peel", "30/09/2023"],
      ["Hema", "9.84801E+09", "", "Peel", "30/09/2026"],
      ["Indu", "9848011111", "", "Peel", "30/09/2026", "", "once"],
      ["Jaya", "9848011111", "", "Peel", "30/09/2026", "", "", "0"],
      ["Kavya", "9848011111", "", "x".repeat(201), "30/09/2026"],
      ["Lata", "98480111", "", "Peel", "30/09/2026"],
    ];
    const r = read(rows);
    expect(r.visits).toEqual([]);
    expect(r.rejected).toEqual([
      { row: 2, reason: "No phone number." },
      { row: 3, reason: "The phone number is not one JENAI can read." },
      { row: 4, reason: "No service or treatment." },
      { row: 5, reason: "No visit date." },
      { row: 6, reason: "The visit date is not a date JENAI can read. Write it day first, like 01/10/2026 or 1 Oct 2026." },
      { row: 7, reason: "The visit date is in the future. The list is for visits that have happened." },
      { row: 8, reason: "The visit date is more than 3 years ago." },
      { row: 9, reason: "Excel has rounded the phone number off (it shows like 9.8E+09). Format the column as Text in Excel and export again." },
      { row: 10, reason: "Sessions done is not a number." },
      { row: 11, reason: "Total sessions has to be 1 or more." },
      { row: 12, reason: "The service name is longer than 200 characters." },
      { row: 13, reason: "The phone number is not one JENAI can read." },
    ]);
    for (const { reason } of r.rejected) for (const cell of rows.flat().filter((c) => c.length > 3)) expect(reason).not.toContain(cell);
  });

  it("takes visits up to exactly 3 years back, today, and skips blank lines without counting them", () => {
    const r = read([["A", "9848011111", "", "Peel", "01/10/2023"], [""], ["A", "9848011111", "", "Peel", "01/10/2026"]]);
    expect(r.rejected).toEqual([]);
    expect(r.rows).toBe(2);
    expect(r.visits.map((v) => [v.row, v.visitDate])).toEqual([
      [2, "2023-10-01"],
      [4, "2026-10-01"],
    ]);
  });

  it("reads numbers, sessions, placeholders and branches the way exports write them", () => {
    const r = read([
      ["Ravi", "-", "+91 98480 22222", " Laser  Hair ", "20-Sep-2026", "Zennara Kondapur", "Session 3/6", ""],
      ["Sita", "98480 33333 / 99490 44444", "", "PRP", "20/09/2026", "jubilee hills", "2", "4"],
      ["N/A", "9848055555.0", "", "Peel", "20/09/2026", "Hitech City", "", ""],
      ["Uma", "9.84801E+09", "9848077777", "Peel", "20/09/2026"],
      ["Vani", "", "+44 7700 900123", "Peel", "20/09/2026"],
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.visits).toEqual([
      { row: 2, phone: "+919848022222", name: "Ravi", service: "Laser Hair", visitDate: "2026-09-20", doctor: null, branch: "Zennara Kondapur", branchId: "b-kdp", sessionsDone: 3, sessionsTotal: 6 },
      { row: 3, phone: "+919848033333", name: "Sita", service: "PRP", visitDate: "2026-09-20", doctor: null, branch: "jubilee hills", branchId: "b-jub", sessionsDone: 2, sessionsTotal: 4 },
      { row: 4, phone: "+919848055555", name: null, service: "Peel", visitDate: "2026-09-20", doctor: null, branch: "Hitech City", branchId: null, sessionsDone: null, sessionsTotal: null },
      { row: 5, phone: "+919848077777", name: "Uma", service: "Peel", visitDate: "2026-09-20", doctor: null, branch: null, branchId: null, sessionsDone: null, sessionsTotal: null },
      { row: 6, phone: "+447700900123", name: "Vani", service: "Peel", visitDate: "2026-09-20", doctor: null, branch: null, branchId: null, sessionsDone: null, sessionsTotal: null },
    ]);
  });

  it("keeps an uploader whose role covers some branches to those branches", () => {
    const r = read(
      [
        ["A", "9848011111", "", "Peel", "30/09/2026", "KDP"],
        ["B", "9848011112", "", "Peel", "30/09/2026", "Jubilee Hills"],
        ["C", "9848011113", "", "Peel", "30/09/2026", ""],
      ],
      { allowedBranchIds: ["b-kdp"] },
    );
    expect(r.visits.map((v) => v.row)).toEqual([2]);
    expect(r.rejected).toEqual([
      { row: 3, reason: "This row is for a branch your role does not cover." },
      { row: 4, reason: "This row names no branch, and your role covers only some branches." },
    ]);
    // Covering every branch there is: nothing to keep them to.
    expect(read([["C", "9848011113", "", "Peel", "30/09/2026", ""]], { allowedBranchIds: ["b-kdp", "b-jub"] }).rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------- importVisits, against the database

describe("importing a visit list", () => {
  let org = "";
  let kondapur = "";
  const ANITHA = "+919848011111";
  const RAVI = "+919848022222";
  const SITA = "+919848066666";
  const FILE = [
    "Zennara Clinics - Services report",
    "From 01/09/2026 to 30/09/2026",
    "",
    "Bill Date,Guest Name,Guest Mobile,Item,Therapist,Centre,Sitting,No. of Sessions",
    "30/09/2026,Anitha,98480 11111,Hydrafacial,Dr Rao,Zennara Kondapur,,",
    "20-Sep-2026,Ravi,+91 98480 22222,Laser Hair Removal - Full Face,Dr Rao,Kondapur,2,6",
    "20/09/26,Ravi,9848022222,laser hair removal - full face,,KDP,2,",
    "01/10/2026,Unknown,12345,Peel,,,,",
    "05/10/2026,Later,9848033333,Peel,,,,",
    "01/01/2020,Earlier,9848044444,Peel,,,,",
    "30/09/2026,Nobody,9848055555,,,,,",
    '"30/09/2026","Sita, K","98480 66666","PRP ""Hair""",,Kondapur,,',
    "",
  ].join("\r\n");

  beforeAll(async () => {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name: "Visit List Clinic", slug: `visits-${randomUUID().slice(0, 8)}`, status: "active", vertical: "dermatology", languages: ["en"] })
      .returning({ id: organizations.id });
    org = o!.id;
    await withTenant(org, async (tx) => {
      const [b] = await tx.insert(branches).values({ tenantId: org, name: "Kondapur", code: "KDP", languages: ["en"] }).returning({ id: branches.id });
      kondapur = b!.id;
      await tx.insert(contacts).values([
        { tenantId: org, phoneE164: ANITHA, name: "Anitha Reddy", source: "call", tags: [] },
        { tenantId: org, phoneE164: RAVI, name: null, source: "call", tags: [] },
      ]);
    });
  });

  afterAll(async () => {
    await platformDb().delete(organizations).where(inArray(organizations.id, [org]));
  });

  const stored = async () => (await withTenant(org, (tx) => tx.select().from(visits))).sort((a, b) => (a.phoneE164 ?? "").localeCompare(b.phoneE164 ?? ""));

  it("stores each visit once, refuses what it cannot use, and logs nothing about anyone", async () => {
    const said = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log"));
    const r = await importVisits(org, FILE, { source: "upload", uploadedBy: "user-1", now: NOW });
    for (const s of said) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
    expect(r).toMatchObject({ rows: 8, added: 3, updated: 0, unchanged: 0, repeated: 1 });
    expect(r.columns).toEqual({ phone: "Guest Mobile", service: "Item", date: "Bill Date", name: "Guest Name", doctor: "Therapist", branch: "Centre", sessions_done: "Sitting", sessions_total: "No. of Sessions" });
    expect(r.rejected).toEqual([
      { row: 8, reason: "The phone number is not one JENAI can read." },
      { row: 9, reason: "The visit date is in the future. The list is for visits that have happened." },
      { row: 10, reason: "The visit date is more than 3 years ago." },
      { row: 11, reason: "No service or treatment." },
    ]);

    const v = await stored();
    expect(v.map((x) => [x.phoneE164, x.service, x.visitDate, x.branchId, x.sessionsDone, x.sessionsTotal, x.source, x.batch])).toEqual([
      [ANITHA, "Hydrafacial", "2026-09-30", kondapur, null, null, "upload", r.batch],
      [RAVI, "Laser Hair Removal - Full Face", "2026-09-20", kondapur, 2, 6, "upload", r.batch],
      [SITA, 'PRP "Hair"', "2026-09-30", kondapur, null, null, "upload", r.batch],
    ]);
    expect(v[1]!.doctor).toBe("Dr Rao");
  });

  it("keeps a contact for every number, naming only those with no name, and links the visits to them", async () => {
    const people = await withTenant(org, (tx) => tx.select().from(contacts));
    const of = (p: string) => people.find((c) => c.phoneE164 === p)!;
    expect(people).toHaveLength(3);
    expect(of(ANITHA)).toMatchObject({ name: "Anitha Reddy", source: "call" });
    expect(of(RAVI)).toMatchObject({ name: "Ravi", source: "call" });
    expect(of(SITA)).toMatchObject({ name: "Sita, K", source: "visit_list", branchId: kondapur });
    for (const x of await stored()) expect(x.contactId).toBe(of(x.phoneE164!).id);
  });

  it("plans the feedback call and the result check for what they had, and one check-in for a sitting partway through a course", async () => {
    const rows = await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.originType, "visit")));
    const ids = new Map((await stored()).map((x) => [x.phoneE164, x.id]));
    const journeys = (p: string) => rows.filter((r) => r.originId === ids.get(p)).map((r) => r.journey).sort();
    expect(journeys(ANITHA)).toEqual(["maintenance", "result_check", "visit_feedback"]);
    // Sitting 2 of 6: no feedback or result check, only the check-in before the next sitting.
    expect(journeys(RAVI)).toEqual(["course_checkin"]);
    const feedback = rows.find((r) => r.originId === ids.get(ANITHA) && r.journey === "visit_feedback")!;
    expect(feedback).toMatchObject({ verdict: "scheduled", phoneE164: ANITHA, callAt: new Date("2026-10-02T10:00:00+05:30") });
    expect(feedback.reason).toMatch(/^Visited on Wed 30 Sep 2026 for Hydrafacial\./);
    const ravi = rows.find((r) => r.originId === ids.get(RAVI))!;
    // 3 days before the next sitting is due on 25 Oct. The branch the row named ("KDP") is matched to a JENAI branch, which the call names as the clinic does.
    expect(ravi).toMatchObject({ verdict: "scheduled", callAt: new Date("2026-10-22T10:00:00+05:30") });
    expect(ravi.context).toEqual({ caller_name: "Ravi", treatment: "Laser Hair Removal - Full Face", last_visit: "2026-09-20", sitting_number: "2", sessions_left: "4", next_due: "2026-10-25", doctor: "Dr Rao", branch: "Kondapur" });
  });

  it("changes nothing when the same file is uploaded again", async () => {
    const before = await stored();
    const r = await importVisits(org, FILE, { source: "upload", uploadedBy: "user-1", now: NOW });
    expect(r).toMatchObject({ rows: 8, added: 0, updated: 0, unchanged: 3, repeated: 1 });
    expect(r.rejected).toHaveLength(4);
    expect(await stored()).toEqual(before);
    expect(await withTenant(org, (tx) => tx.select().from(contacts))).toHaveLength(3);
  });

  it("fills in what a later file adds, and keeps what it leaves empty", async () => {
    const r = await importVisits(org, "Mobile,Service,Date,Doctor,Sessions Done\n9848011111,HYDRAFACIAL,30/09/2026,Dr Priya,\n9848022222,Laser Hair Removal - Full Face,20/09/2026,,", { now: NOW });
    expect(r).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    const v = await stored();
    expect(v.find((x) => x.phoneE164 === ANITHA)).toMatchObject({ service: "Hydrafacial", doctor: "Dr Priya", batch: r.batch });
    expect(v.find((x) => x.phoneE164 === RAVI)).toMatchObject({ doctor: "Dr Rao", sessionsDone: 2, sessionsTotal: 6 });
  });

  it("records each upload in the activity log with counts only", async () => {
    const events = await withTenant(org, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "visits.imported")));
    expect(events).toHaveLength(3);
    const first = events.sort((a, b) => a.id - b.id)[0]!;
    expect(first).toMatchObject({ actorUserId: "user-1", via: "user", targetType: "visit_batch", summary: "Visit list uploaded: 3 added, 0 updated, 0 unchanged, 4 rows refused" });
    expect(first.diff).toEqual({ rows: 8, added: 3, updated: 0, unchanged: 0, repeated: 1, rejected: 4 });
    expect(events.find((e) => e.actorUserId === null)).toMatchObject({ via: "system" });
    const text = JSON.stringify(events.map((e) => [e.summary, e.diff, e.targetType]));
    for (const secret of ["98480", "Anitha", "Ravi", "Sita", "Hydrafacial", "Rao"]) expect(text).not.toContain(secret);
  });

  it("refuses a file with too many rows or no phone column, and stores nothing from it", async () => {
    const big = ["Mobile,Service,Date", ...Array.from({ length: VISIT_IMPORT_MAX_ROWS + 1 }, (_, i) => `98${String(i).padStart(8, "0")},Peel,30/09/2026`)].join("\n");
    await expect(importVisits(org, big, { now: NOW })).rejects.toThrow(/more than 20,000 rows/);
    await expect(importVisits(org, "Name,Service,Date\nA,Peel,30/09/2026", { now: NOW })).rejects.toThrow(VisitImportError);
    await expect(importVisits(org, "\r\n\r\n", { now: NOW })).rejects.toThrow("The file is empty.");
    expect(await stored()).toHaveLength(3);
  });

  it("takes out an upload's visits, and their planned calls, when asked", async () => {
    const r = await importVisits(org, "Mobile,Service,Date\n9848077777,Peel,29/09/2026", { now: NOW });
    expect((await stored()).some((x) => x.phoneE164 === "+919848077777")).toBe(true);
    const out = await removeVisitUpload(org, r.batch, { removedBy: "user-1", now: NOW });
    expect(out.removed).toBe(1);
    expect((await stored()).some((x) => x.phoneE164 === "+919848077777")).toBe(false);
    expect(await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.phoneE164, "+919848077777")))).toEqual([]);
    const [logged] = await withTenant(org, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "visits.upload_removed")));
    expect(logged).toMatchObject({ targetId: r.batch, summary: "Visit list upload removed: 1 visit taken out", diff: { removed: 1 } });
    await expect(removeVisitUpload(org, "not-a-batch")).rejects.toThrow(VisitRemovalError);
  });

  it("erases one person from what the plan keeps, naming them nowhere in the log", async () => {
    const r = await eraseNumber(org, "98480 66666", { removedBy: "user-1", now: NOW });
    expect(r).toMatchObject({ visits: 1 });
    expect(r.planned).toBeGreaterThan(0);
    expect((await stored()).some((x) => x.phoneE164 === SITA)).toBe(false);
    expect(await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.phoneE164, SITA)))).toEqual([]);
    // The name the visit list gave their contact goes too; a contact from a call keeps its own.
    const people = await withTenant(org, (tx) => tx.select().from(contacts));
    expect(people.find((c) => c.phoneE164 === SITA)!.name).toBeNull();
    const [logged] = await withTenant(org, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "call_plan.number_erased")));
    expect(logged).toMatchObject({ targetType: "phone", targetId: "ending 6666" });
    expect(JSON.stringify(logged)).not.toMatch(/98480|Sita/);
    await expect(eraseNumber(org, "12")).rejects.toThrow(VisitRemovalError);
  });
});
