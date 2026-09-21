import { C, barChart, css, donut, logo, progressRows, rankedList } from "./brand";
import type { CallsSummary } from "./data";

/**
 * The calls report a client downloads: three pages, tiles and charts, in
 * JENAI's own brand. Page one answers "how did it go", page two "when and with
 * whom", page three "what this does not yet show, and what to do next".
 */

const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const fmtNum = (n: number) => n.toLocaleString("en-IN");
const fmtMins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const delta = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / before) * 100));
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** "About 3 hours" or "About 40 minutes", never "1 hours". */
function hours(minutes: number): string {
  if (minutes < 90) return `That is about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.round(minutes / 60);
  return `That is about ${h} hour${h === 1 ? "" : "s"}`;
}

const STATUS_LABEL: Record<string, string> = {
  completed: "Answered and finished",
  no_answer: "Nobody picked up",
  busy: "Line was busy",
  failed: "Could not connect",
  in_progress: "Still on a call",
  ringing: "Ringing",
  queued: "Waiting to be dialled",
  unknown: "Not recorded",
};

function head(s: CallsSummary, subtitle: string): string {
  return `<div class="masthead">
    <div>${logo(24)}<div class="who">Diigoo Tech Private Limited</div></div>
    <div class="right"><div class="kicker">${esc(subtitle)}</div>
      <div style="font-size:11px;font-weight:700;margin-top:6px">${esc(s.org.name)}</div>
      <div style="font-size:8.2px;color:${C.grey}">${fmtDate(s.from)} to ${fmtDate(s.to)}</div>
    </div>
  </div>`;
}

function foot(page: number, of: number, s: CallsSummary): string {
  return `<div class="foot"><span>${esc(s.org.name)} · calls report</span><span>jenai.in · page ${page} of ${of}</span></div>`;
}

function tile(label: string, value: string, note = "", dark = false): string {
  return `<div class="card${dark ? " dark" : ""}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ""}</div>`;
}

export function callsReportHtml(s: CallsSummary): string {
  const t = s.totals;
  const answeredPct = pct(t.answered, t.calls);
  const days = s.byDay.slice(-14).map((d) => ({
    label: new Date(`${d.date}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }),
    value: d.total,
    highlight: d.total === Math.max(...s.byDay.map((x) => x.total)),
  }));
  const busiest = [...s.byHour].sort((a, b) => b.value - a.value).slice(0, 4);
  const busiestDay = [...s.byDay].sort((a, b) => b.total - a.total)[0];
  const outcomeGap = t.calls - s.coverage.withOutcome;

  const page1 = `<section class="page">
    ${head(s, "calls report")}
    <h1>how the calls went</h1>
    <p style="max-width:78ch">Every call your AI assistant handled in this period, inbound and outbound, with how long people stayed on the line. Figures in this report come from the calls themselves, not from estimates.</p>

    <div class="grid g4" style="margin:12px 0 9px">
      ${tile("Total calls", fmtNum(t.calls), `${fmtNum(t.inbound)} in · ${fmtNum(t.outbound)} out`)}
      ${tile("Answered", `${answeredPct}%`, `${fmtNum(t.answered)} of ${fmtNum(t.calls)} connected`)}
      ${tile("Average length", fmtMins(t.avgSeconds), `${fmtNum(t.minutes)} minutes in total`)}
      ${tile("People reached", fmtNum(t.people), `${fmtNum(t.recordings)} recordings kept`, true)}
    </div>

    <div class="grid split" style="margin-bottom:9px">
      <div class="card">
        <h2>Calls a day</h2>
        ${barChart(days)}
        <div class="legend"><span><span class="dot" style="background:${C.copper}"></span>busiest day</span><span><span class="dot" style="background:${C.copperSoft}"></span>other days</span></div>
      </div>
      <div class="card">
        <h2>Who called whom</h2>
        <div style="display:flex;justify-content:center;padding:4px 0 2px">
          ${donut(
            [
              { label: "Inbound", value: t.inbound, color: C.copper },
              { label: "Outbound", value: t.outbound, color: C.ink },
            ],
            { value: `${pct(t.inbound, t.calls)}%`, caption: "came to you" },
          )}
        </div>
        <div class="legend">
          <span><span class="dot" style="background:${C.copper}"></span>Inbound ${fmtNum(t.inbound)}</span>
          <span><span class="dot" style="background:${C.ink}"></span>Outbound ${fmtNum(t.outbound)}</span>
        </div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <h2>Against the period before</h2>
        ${rankedList([
          { label: "Calls handled", value: fmtNum(t.calls), delta: delta(t.calls, s.previous.calls) },
          { label: "Answered", value: fmtNum(t.answered), delta: delta(t.answered, s.previous.answered) },
          { label: "Average length", value: fmtMins(t.avgSeconds), delta: delta(t.avgSeconds, s.previous.avgSeconds) },
          { label: "Minutes on calls", value: fmtNum(t.minutes), delta: delta(t.minutes, s.previous.minutes) },
        ])}
      </div>
      <div class="card">
        <h2>How calls ended</h2>
        ${rankedList(
          s.statuses.slice(0, 5).map((x) => ({
            label: STATUS_LABEL[x.label] ?? x.label.replace(/_/g, " "),
            value: `${fmtNum(x.value)} · ${pct(x.value, t.calls)}%`,
            delta: null,
          })),
        )}
      </div>
    </div>
    ${foot(1, 3, s)}
  </section>`;

  const page2 = `<section class="page">
    ${head(s, "when and with whom")}
    <h1>when people call</h1>
    <p style="max-width:78ch">Use this to decide when a human should be free to take a handover, and when the line can run on its own.</p>

    <div class="grid split" style="margin:12px 0 9px">
      <div class="card">
        <h2>Busiest hours</h2>
        ${progressRows(busiest.map((b) => ({ label: b.label, value: b.value, suffix: " calls" })))}
        <p style="margin-top:9px;font-size:8.6px">${busiest[0] ? `Most calls arrive around ${esc(busiest[0].label)}.` : "Not enough calls yet to see a pattern."} ${busiestDay ? `The busiest day was ${fmtDate(new Date(`${busiestDay.date}T00:00:00+05:30`))} with ${busiestDay.total} calls.` : ""}</p>
      </div>
      <div class="card dark">
        <h2 style="color:${C.ivory}">What this costs you in staff time</h2>
        <div class="tile-value">${fmtNum(t.minutes)} min</div>
        <div class="tile-note">answered by the AI in this period</div>
        <p style="margin-top:9px">${hours(t.minutes)} a front desk did not have to spend on the phone${t.calls - t.answered > 0 ? `, and ${fmtNum(t.calls - t.answered)} call${t.calls - t.answered === 1 ? "" : "s"} that did not connect and can be followed up` : ""}.</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:9px">
      <h2>Longest conversations</h2>
      <table>
        <thead><tr><th>When</th><th>Direction</th><th>Number</th><th style="text-align:right">Length</th></tr></thead>
        <tbody>
          ${s.longest
            .map(
              (l) => `<tr><td>${fmtDate(l.when)}, ${l.when.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
            <td>${l.direction === "inbound" ? "They called" : "We called"}</td><td>${esc(l.phone)}</td><td style="text-align:right">${fmtMins(l.seconds)}</td></tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p style="margin-top:7px;font-size:8.4px">Numbers are partly hidden. Staff with permission can see the full number and play the recording in JENAI.</p>
    </div>

    <div class="grid g2">
      <div class="card">
        <h2>Lines in use</h2>
        ${s.numbers.length
          ? `<table><thead><tr><th>Number</th><th>Type</th></tr></thead><tbody>${s.numbers
              .map((n) => `<tr><td>${esc(n.e164)}</td><td>${esc(n.series.replace("series_", "").replace("_", " "))}${n.label ? ` · ${esc(n.label)}` : ""}</td></tr>`)
              .join("")}</tbody></table>`
          : `<p>No numbers recorded in JENAI yet.</p>`}
      </div>
      <div class="card">
        <h2>Assistants answering</h2>
        ${s.agents.length
          ? `<ul class="ranked">${s.agents.map((a) => `<li><span class="rk-label">${esc(a.name)}</span><span class="rk-val">${a.live ? "live" : "draft"}</span></li>`).join("")}</ul>`
          : `<p>No assistant set up in JENAI yet.</p>`}
      </div>
    </div>
    ${foot(2, 3, s)}
  </section>`;

  const page3 = `<section class="page">
    ${head(s, "what to do next")}
    <h1>what this report cannot tell you yet</h1>

    <div class="grid g3" style="margin:12px 0 9px">
      ${tile("Calls with an outcome", `${pct(s.coverage.withOutcome, t.calls)}%`, `${fmtNum(s.coverage.withOutcome)} of ${fmtNum(t.calls)} calls`)}
      ${tile("Appointments recorded", fmtNum(s.booked), s.booked ? "from what the caller agreed" : "none captured in this period")}
      ${tile("Leads created", fmtNum(s.leads.reduce((a, l) => a + l.value, 0)), s.leads.map((l) => `${l.value} ${l.label}`).join(" · ") || "none yet")}
    </div>

    ${outcomeGap > 0
      ? `<div class="warn" style="margin-bottom:9px">
          <strong>${fmtNum(outcomeGap)} of ${fmtNum(t.calls)} calls have no recorded outcome.</strong>
          The system answering these calls today stores the audio but does not hand back what was agreed, so nobody can see from a report whether a caller booked, asked for a price or wanted a callback.
          Once this workspace is on the new platform, every finished call is read automatically and the outcome, the treatment asked about and any appointment are written against the caller, in English, whatever language the call was in.
        </div>`
      : `<div class="note" style="margin-bottom:9px">Every call in this period has a recorded outcome.</div>`}

    <div class="grid g2" style="margin-bottom:9px">
      <div class="card">
        <h2>What we suggest</h2>
        <ul style="margin:0;padding-left:16px;color:${C.inkSoft}">
          <li>Turn on outcome reading, so each call records what was agreed.</li>
          <li>Put a person on the busiest hour for handovers.</li>
          <li>Follow up the ${fmtNum(t.calls - t.answered)} calls that did not connect.</li>
          <li>Send these results into your own CRM, so your team works in one place.</li>
        </ul>
      </div>
      <div class="card">
        <h2>How your calls are kept lawful</h2>
        <p>Every outbound call passes a check before it is dialled: do-not-call and DND lists, consent for that kind of call, a caller ID declared for AI calling, and calling hours between 9 AM and 9 PM.</p>
        <p style="margin:0">Recordings and call records are kept in India. Who listened to which recording is recorded.</p>
      </div>
    </div>

    <div class="card dark">
      <h2 style="color:${C.ivory}">In one line</h2>
      <p style="font-size:11px;color:${C.ivory}">
        ${fmtNum(t.calls)} calls, ${answeredPct}% answered, ${fmtNum(t.minutes)} minutes handled by the assistant between ${fmtDate(s.from)} and ${fmtDate(s.to)}${
          outcomeGap > 0 ? `, with outcomes still missing on ${fmtNum(outcomeGap)} of them.` : "."
        }
      </p>
    </div>
    ${foot(3, 3, s)}
  </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>${esc(s.org.name)} calls report</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
    <style>${css()}</style></head>
    <body><div class="glow glow-a"></div><div class="glow glow-b"></div>${page1}${page2}${page3}</body></html>`;
}
