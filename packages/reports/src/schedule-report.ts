import { C, css, logo, progressRows } from "./brand";

/**
 * The day or week schedule, printed. Staff put this on the front desk, and it
 * is the same brand as every other JENAI document. Print to PDF from the
 * browser gives a clean A4 sheet.
 */

export interface ScheduleEntry {
  id: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  personName: string | null;
  phone: string | null;
  kind: string;
  status: string;
  notes: string | null;
  source: string;
  resourceName: string | null;
  resourceColour: string | null;
}

export interface ScheduleInput {
  orgName: string;
  from: Date;
  to: Date;
  rangeLabel: string;
  entries: ScheduleEntry[];
  people: Array<{ id: string; name: string; colour: string }>;
  filteredTo?: string | null;
}

const TZ = "Asia/Kolkata";
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const time = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dateLong = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const KIND: Record<string, string> = { visit: "Visit", follow_up: "Follow-up", procedure: "Procedure", call_back: "Call back", block: "Not available", other: "Other" };
const STATUS: Record<string, string> = { booked: "Booked", confirmed: "Confirmed", arrived: "Arrived", completed: "Done", cancelled: "Cancelled", no_show: "Did not come" };

export function scheduleReportHtml(s: ScheduleInput): string {
  const days = new Map<string, ScheduleEntry[]>();
  for (const e of s.entries) days.set(dayKey(e.startsAt), [...(days.get(dayKey(e.startsAt)) ?? []), e]);

  const fromCalls = s.entries.filter((e) => e.source === "call").length;
  const byPerson = s.people
    .map((p) => ({ label: p.name, value: s.entries.filter((e) => e.resourceName === p.name).length }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  const tiles = `<div class="grid g4" style="margin:12px 0 10px">
    <div class="card"><div class="tile-label">Entries</div><div class="tile-value">${s.entries.length}</div><div class="tile-note">${esc(s.rangeLabel)}</div></div>
    <div class="card"><div class="tile-label">Booked on a call</div><div class="tile-value">${fromCalls}</div><div class="tile-note">by the AI assistant</div></div>
    <div class="card"><div class="tile-label">People and rooms</div><div class="tile-value">${byPerson.length}</div><div class="tile-note">with something on</div></div>
    <div class="card dark"><div class="tile-label">First and last</div><div class="tile-value" style="font-size:18px">${s.entries.length ? `${time(s.entries[0]!.startsAt)} to ${time(s.entries[s.entries.length - 1]!.endsAt)}` : "nothing booked"}</div></div>
  </div>`;

  const tables = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, list]) => {
      const rows = list
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map(
          (e) => `<tr>
            <td style="white-space:nowrap">${time(e.startsAt)} to ${time(e.endsAt)}</td>
            <td><strong>${esc(e.personName ?? e.title)}</strong>${e.phone ? `<div style="color:${C.grey};font-size:8.4px">${esc(e.phone)}</div>` : ""}</td>
            <td>${e.resourceColour ? `<span style="display:inline-block;width:7px;height:7px;border-radius:99px;background:${e.resourceColour};margin-right:5px"></span>` : ""}${esc(e.resourceName ?? "not assigned")}</td>
            <td>${esc(KIND[e.kind] ?? e.kind)}</td>
            <td>${esc(STATUS[e.status] ?? e.status)}${e.source === "call" ? ` <span style="color:${C.copper}">· from a call</span>` : ""}</td>
            <td style="color:${C.inkSoft}">${esc((e.notes ?? "").slice(0, 70))}</td>
          </tr>`,
        )
        .join("");
      return `<div class="card" style="margin-bottom:9px">
        <h2>${esc(dateLong(new Date(`${k}T09:00:00+05:30`)))}</h2>
        <table>
          <thead><tr><th>Time</th><th>Who</th><th>With</th><th>What</th><th>State</th><th>Note</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>${esc(s.orgName)} schedule</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <style>${css()}
    @media print { .noprint { display: none !important; } }
    .noprint { position: sticky; top: 0; display: flex; gap: 8px; align-items: center; justify-content: flex-end;
      background: ${C.ivory}; padding: 8px 0 10px; }
    .btn { font: inherit; font-weight: 700; border: 1px solid ${C.ink}; background: ${C.ink}; color: ${C.ivory};
      border-radius: 999px; padding: 7px 14px; cursor: pointer; text-decoration: none; font-size: 10px; }
    .btn.ghost { background: transparent; color: ${C.ink}; }
  </style></head>
  <body><div class="glow glow-a"></div><div class="glow glow-b"></div>
  <section class="page">
    <div class="noprint">
      <span style="margin-right:auto;font-size:9px;color:${C.grey}">Print this, or save it as a PDF from the print window.</span>
      <button class="btn" onclick="window.print()">Print or save as PDF</button>
    </div>
    <div class="masthead">
      <div>${logo(24)}<div class="who">Diigoo Tech Private Limited</div></div>
      <div class="right"><div class="kicker">schedule</div>
        <div style="font-size:11px;font-weight:700;margin-top:6px">${esc(s.orgName)}</div>
        <div style="font-size:8.2px;color:${C.grey}">${esc(s.rangeLabel)}${s.filteredTo ? ` · ${esc(s.filteredTo)} only` : ""}</div>
      </div>
    </div>
    <h1>what is on</h1>
    ${tiles}
    ${byPerson.length ? `<div class="card" style="margin-bottom:9px"><h2>Who is busiest</h2>${progressRows(byPerson.map((p) => ({ label: p.label, value: p.value, suffix: "" })))}</div>` : ""}
    ${tables || `<div class="note">Nothing in the calendar for this period.</div>`}
    <div class="foot"><span>${esc(s.orgName)} · schedule</span><span>jenai.in · printed ${new Date().toLocaleString("en-IN", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}</span></div>
  </section></body></html>`;
}

/** An .ics file, so entries drop into Google Calendar, Outlook or Apple Calendar. */
export function icsFeed(orgName: string, entries: ScheduleEntry[], feedUrl?: string): string {
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
  const fold = (line: string): string => (line.length <= 73 ? line : `${line.slice(0, 73)}\r\n ${fold(line.slice(73))}`);
  const clean = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const events = entries
    .filter((e) => e.status !== "cancelled")
    .map((e) =>
      [
        "BEGIN:VEVENT",
        `UID:${e.id}@jenai.in`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(e.startsAt)}`,
        `DTEND:${stamp(e.endsAt)}`,
        fold(`SUMMARY:${clean(e.personName ?? e.title)}${e.resourceName ? clean(` with ${e.resourceName}`) : ""}`),
        fold(
          `DESCRIPTION:${clean(
            [KIND[e.kind] ?? e.kind, e.phone ?? "", e.notes ?? "", e.source === "call" ? "Booked by the AI assistant on a call." : ""].filter(Boolean).join("\n"),
          )}`,
        ),
        `STATUS:${e.status === "completed" ? "CONFIRMED" : "TENTATIVE"}`,
        "END:VEVENT",
      ].join("\r\n"),
    )
    .join("\r\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JENAI//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:${clean(orgName)} (JENAI)`),
    "X-WR-TIMEZONE:Asia/Kolkata",
    ...(feedUrl ? [fold(`X-ORIGINAL-URL:${feedUrl}`), "X-PUBLISHED-TTL:PT30M", "REFRESH-INTERVAL;VALUE=DURATION:PT30M"] : []),
    events,
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

/** The same rows as a spreadsheet, for Excel or Google Sheets. */
export function scheduleCsv(entries: ScheduleEntry[]): string {
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Date", "Start", "End", "Who", "Phone", "With", "What", "State", "Source", "Note"];
  const rows = entries.map((e) => [
    dayKey(e.startsAt),
    time(e.startsAt),
    time(e.endsAt),
    e.personName ?? e.title,
    e.phone ?? "",
    e.resourceName ?? "",
    KIND[e.kind] ?? e.kind,
    STATUS[e.status] ?? e.status,
    e.source === "call" ? "booked on a call" : e.source,
    e.notes ?? "",
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
