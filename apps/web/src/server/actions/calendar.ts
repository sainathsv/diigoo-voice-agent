"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, withTenant } from "@jenai/db";
import { CalendarError, createAppointment, saveResource, updateAppointment } from "@jenai/engine";
import { actorFields, requireWorkspace, workspaceAction } from "../access";
import { requestMeta } from "../session";

/** Times come from the form as local (India) values, never as UTC. */
function istDate(date: string, time?: string): Date {
  const t = /^\d{2}:\d{2}$/.test(time ?? "") ? time : "10:00";
  return new Date(`${date}T${t}:00+05:30`);
}

const go = (slug: string, q: Record<string, string>): never => {
  redirect(`/w/${slug}/calendar?${new URLSearchParams(q)}`);
};

async function meta(ctx: Awaited<ReturnType<typeof requireWorkspace>>) {
  return { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()) };
}

const Entry = z.object({
  slug: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  minutes: z.coerce.number().int().min(5).max(600).optional(),
  title: z.string().trim().max(120).optional(),
  personName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  resourceId: z.union([z.uuid(), z.literal("")]).optional(),
  branchId: z.union([z.uuid(), z.literal("")]).optional(),
  kind: z.enum(["visit", "follow_up", "procedure", "call_back", "block", "other"]).optional(),
  notes: z.string().trim().max(500).optional(),
  allDay: z.string().optional(),
  view: z.string().optional(),
});

/** Write an entry: a visit, a follow-up, leave, a camp, anything the day holds. */
export async function addEntry(fd: FormData) {
  const p = Entry.safeParse(Object.fromEntries(fd));
  if (!p.success) redirect(`/w/${String(fd.get("slug"))}/calendar?error=${encodeURIComponent("Check the date and time.")}`);
  const d = p.data!;
  const ctx = await workspaceAction(d.slug, "calendar:edit");
  const startsAt = istDate(d.date, d.time);
  try {
    const a = await createAppointment(
      ctx.org.id,
      {
        title: d.title || d.personName || (d.kind === "block" ? "Not available" : "Visit"),
        kind: d.kind ?? "visit",
        startsAt,
        minutes: d.minutes ?? 30,
        allDay: d.allDay === "on",
        resourceId: d.resourceId || null,
        branchId: d.branchId || null,
        personName: d.personName || null,
        phone: d.phone || null,
        notes: d.notes || null,
        source: "manual",
      },
      ctx.user.userId,
    );
    await withTenant(ctx.org.id, async (tx) =>
      audit(tx, { ...(await meta(ctx)), action: "calendar.entry_added", targetType: "appointment", targetId: a.id, summary: `Added "${a.title}" on ${d.date}${d.time ? ` at ${d.time}` : ""}` }),
    );
    go(d.slug, { d: d.date, view: d.view ?? "day", ok: "Added to the calendar." });
  } catch (e) {
    if (e instanceof CalendarError) go(d.slug, { d: d.date, view: d.view ?? "day", error: e.message });
    throw e;
  }
}

const Change = z.object({
  slug: z.string(),
  id: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  minutes: z.coerce.number().int().min(5).max(600).optional(),
  resourceId: z.union([z.uuid(), z.literal("")]).optional(),
  status: z.enum(["booked", "confirmed", "arrived", "completed", "cancelled", "no_show"]).optional(),
  notes: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(200).optional(),
  view: z.string().optional(),
  back: z.string().optional(),
});

/** Move it, mark who turned up, or cancel it. */
export async function changeEntry(fd: FormData) {
  const p = Change.safeParse(Object.fromEntries(fd));
  if (!p.success) redirect(`/w/${String(fd.get("slug"))}/calendar?error=${encodeURIComponent("Could not make that change.")}`);
  const d = p.data!;
  const ctx = await workspaceAction(d.slug, "calendar:edit");
  try {
    const a = await updateAppointment(
      ctx.org.id,
      d.id,
      {
        ...(d.date ? { startsAt: istDate(d.date, d.time), minutes: d.minutes ?? 30 } : {}),
        ...(d.resourceId !== undefined ? { resourceId: d.resourceId || null } : {}),
        ...(d.status ? { status: d.status } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
        ...(d.status === "cancelled" ? { cancelledReason: d.reason || "Cancelled by the team" } : {}),
      },
      ctx.user.userId,
    );
    await withTenant(ctx.org.id, async (tx) =>
      audit(tx, {
        ...(await meta(ctx)),
        action: d.status === "cancelled" ? "calendar.entry_cancelled" : "calendar.entry_changed",
        targetType: "appointment",
        targetId: a.id,
        summary: d.status ? `Marked "${a.title}" as ${d.status.replace("_", " ")}` : `Moved "${a.title}"`,
        diff: { date: d.date ?? null, time: d.time ?? null, status: d.status ?? null },
      }),
    );
    go(d.slug, { d: d.date ?? (d.back ?? ""), view: d.view ?? "day", ok: d.status === "cancelled" ? "Cancelled." : "Updated." });
  } catch (e) {
    if (e instanceof CalendarError) go(d.slug, { d: d.back ?? "", view: d.view ?? "day", error: e.message });
    throw e;
  }
}

/** Doctors, rooms and other people the calendar books against. */
export async function saveCalendarResource(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "calendar:edit");
  const p = z
    .object({
      id: z.union([z.uuid(), z.literal("")]).optional(),
      name: z.string().trim().min(2).max(80),
      kind: z.enum(["doctor", "staff", "room", "equipment"]).optional(),
      title: z.string().trim().max(60).optional(),
      colour: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      branchId: z.union([z.uuid(), z.literal("")]).optional(),
      active: z.string().optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) go(slug, { error: "Give them a name." });
  const d = p.data!;
  const r = await saveResource(
    ctx.org.id,
    { id: d.id || undefined, name: d.name, kind: d.kind, title: d.title || null, colour: d.colour, branchId: d.branchId || null, ...(d.id ? { active: d.active === "on" } : {}) },
    ctx.user.userId,
  );
  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, { ...(await meta(ctx)), action: "calendar.resource_saved", targetType: "resource", targetId: r.id, summary: `${d.id ? "Updated" : "Added"} ${r.kind} ${r.name}` }),
  );
  go(slug, { ok: `${r.name} saved.`, view: "people" });
}
