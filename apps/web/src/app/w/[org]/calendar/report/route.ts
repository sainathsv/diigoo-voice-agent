import { can, holdsAnywhere } from "@jenai/authz";
import { audit, withTenant } from "@jenai/db";
import { TZ, dayRange, listAppointments, listResources } from "@jenai/engine";
import { icsFeed, scheduleCsv, scheduleReportHtml, type ScheduleEntry } from "@jenai/reports";
import { requireWorkspace } from "@/server/access";
import { requestMeta } from "@/server/session";
import { logDenied } from "@/server/security-log";

/**
 * GET /w/{org}/calendar/report?d=YYYY-MM-DD&range=day|week|month&format=html|csv|ics
 * The schedule to print, to open in Excel, or to drop into their own calendar.
 * Every download is recorded: who took what, and how many rows.
 */
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "calendar:view")) {
    await logDenied(ctx, { perm: "calendar:view", area: "calendar download" });
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(req.url);
  const format = ["csv", "ics", "html"].includes(url.searchParams.get("format") ?? "") ? url.searchParams.get("format")! : "html";
  const range = ["day", "week", "month"].includes(url.searchParams.get("range") ?? "") ? url.searchParams.get("range")! : "day";
  const dParam = url.searchParams.get("d");
  const who = /^[0-9a-f-]{36}$/i.test(url.searchParams.get("who") ?? "") ? url.searchParams.get("who") : null;
  const day = dParam && /^\d{4}-\d{2}-\d{2}$/.test(dParam) ? new Date(`${dParam}T09:00:00+05:30`) : new Date();

  const { from } = dayRange(day);
  const to = new Date(from.getTime() + (range === "day" ? 1 : range === "week" ? 7 : 31) * 24 * 3600 * 1000);
  const [rows, people] = await Promise.all([listAppointments(ctx.org.id, from, to, { resourceId: who }), listResources(ctx.org.id)]);

  const reveal = can(ctx.access, "contacts:reveal_phone");
  const entries: ScheduleEntry[] = rows.map((a) => ({
    id: a.id,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    title: a.title,
    personName: a.personName,
    phone: a.phoneE164 ? (reveal ? a.phoneE164 : `${a.phoneE164.slice(0, 6)}•••${a.phoneE164.slice(-2)}`) : null,
    kind: a.kind,
    status: a.status,
    notes: a.notes,
    source: a.source,
    resourceName: a.resourceName,
    resourceColour: a.resourceColour,
  }));

  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, {
      tenantId: ctx.org.id,
      actorUserId: ctx.user.userId,
      via: ctx.support ? "support" : "user",
      action: "calendar.exported",
      targetType: "calendar",
      targetId: `${range}:${new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(day)}`,
      summary: `Downloaded the ${range} schedule as ${format.toUpperCase()} (${entries.length} entries)`,
      diff: { rows: entries.length, format, range, revealed: reveal },
      ...(await requestMeta()),
    }),
  );

  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(day);
  const filename = `${slug}-schedule-${range}-${stamp}`;

  if (format === "csv") {
    return new Response(scheduleCsv(entries), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.csv"`, "Cache-Control": "no-store" },
    });
  }
  if (format === "ics") {
    return new Response(icsFeed(ctx.org.name, entries), {
      headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.ics"`, "Cache-Control": "no-store" },
    });
  }
  const label =
    range === "day"
      ? day.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ })
      : `${from.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ })} to ${new Date(to.getTime() - 1).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })}`;
  const html = scheduleReportHtml({
    orgName: ctx.org.name,
    from,
    to,
    rangeLabel: label,
    entries,
    people: people.map((p) => ({ id: p.id, name: p.name, colour: p.colour })),
    filteredTo: who ? (people.find((p) => p.id === who)?.name ?? null) : null,
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
