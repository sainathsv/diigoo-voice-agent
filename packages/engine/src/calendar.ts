import { and, asc, desc, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  appointments,
  contacts,
  resources,
  withTenant,
  type Appointment,
  type AppointmentKind,
  type AppointmentStatus,
  type Resource,
  type Tx,
} from "@jenai/db";
import { toE164 } from "@jenai/voice";
import { localParts, zoned } from "./dialer/time";

/**
 * The calendar: visits the AI booked, plus everything the team writes in
 * (leave, camps, a room held for a procedure). Times are stored as instants
 * and read in the client's own time zone, which is India for every client today.
 */

export const TZ = "Asia/Kolkata";
const DEFAULT_MINUTES = 30;

export interface AppointmentInput {
  title?: string;
  kind?: AppointmentKind;
  startsAt: Date;
  minutes?: number;
  endsAt?: Date;
  resourceId?: string | null;
  branchId?: string | null;
  contactId?: string | null;
  callId?: string | null;
  personName?: string | null;
  phone?: string | null;
  notes?: string | null;
  allDay?: boolean;
  source?: "call" | "manual" | "api" | "crm" | "import";
  status?: AppointmentStatus;
}

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly code: "in_the_past" | "clash" | "not_found" | "bad_time",
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

/** Day boundaries in India, whatever the server's clock is set to. */
export function dayRange(day: Date, tz = TZ): { from: Date; to: Date } {
  const p = localParts(day, tz);
  const from = zoned(p.y, p.m, p.d, 0, tz);
  return { from, to: new Date(from.getTime() + 24 * 3600 * 1000) };
}

export function monthRange(day: Date, tz = TZ): { from: Date; to: Date; weeks: Date[][] } {
  const p = localParts(day, tz);
  const first = zoned(p.y, p.m, 1, 0, tz);
  const firstParts = localParts(first, tz);
  // Weeks start on Monday, the way an Indian clinic's week reads.
  const lead = (firstParts.dow + 6) % 7;
  const gridStart = new Date(first.getTime() - lead * 24 * 3600 * 1000);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) row.push(new Date(gridStart.getTime() + (w * 7 + d) * 24 * 3600 * 1000));
    weeks.push(row);
  }
  return { from: gridStart, to: new Date(gridStart.getTime() + 42 * 24 * 3600 * 1000), weeks };
}

/** Everything in a window, oldest first, with the doctor or room it is with. */
export async function listAppointments(
  tenantId: string,
  from: Date,
  to: Date,
  filter: { resourceId?: string | null; branchId?: string | null; includeCancelled?: boolean } = {},
): Promise<Array<Appointment & { resourceName: string | null; resourceColour: string | null }>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ a: appointments, name: resources.name, colour: resources.colour })
      .from(appointments)
      .leftJoin(resources, eq(resources.id, appointments.resourceId))
      .where(
        and(
          gte(appointments.startsAt, from),
          lt(appointments.startsAt, to),
          filter.resourceId ? eq(appointments.resourceId, filter.resourceId) : undefined,
          filter.branchId ? eq(appointments.branchId, filter.branchId) : undefined,
          filter.includeCancelled ? undefined : ne(appointments.status, "cancelled"),
        ),
      )
      .orderBy(asc(appointments.startsAt));
    return rows.map((r) => ({ ...r.a, resourceName: r.name, resourceColour: r.colour }));
  });
}

export async function listResources(tenantId: string, includeInactive = false): Promise<Resource[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(resources)
      .where(includeInactive ? undefined : eq(resources.active, true))
      .orderBy(asc(resources.kind), asc(resources.name)),
  );
}

/** Someone already booked with that doctor or in that room at that time. */
async function clashingWith(tx: Tx, tenantId: string, input: { resourceId?: string | null; startsAt: Date; endsAt: Date; ignoreId?: string }) {
  if (!input.resourceId) return null;
  const [clash] = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.resourceId, input.resourceId),
        ne(appointments.status, "cancelled"),
        lt(appointments.startsAt, input.endsAt),
        sql`${appointments.endsAt} > ${input.startsAt.toISOString()}::timestamptz`,
        input.ignoreId ? ne(appointments.id, input.ignoreId) : undefined,
      ),
    )
    .limit(1);
  return clash ?? null;
}

function endOf(input: AppointmentInput): Date {
  if (input.endsAt) return input.endsAt;
  if (input.allDay) return new Date(input.startsAt.getTime() + 24 * 3600 * 1000);
  return new Date(input.startsAt.getTime() + (input.minutes ?? DEFAULT_MINUTES) * 60_000);
}

/** Writes one entry. Refuses a clash unless the caller says to allow it. */
export async function createAppointment(
  tenantId: string,
  input: AppointmentInput,
  actorUserId: string | null,
  opts: { allowClash?: boolean } = {},
): Promise<Appointment> {
  const endsAt = endOf(input);
  if (!(endsAt.getTime() > input.startsAt.getTime())) throw new CalendarError("The end time has to be after the start.", "bad_time");
  return withTenant(tenantId, async (tx) => {
    if (!opts.allowClash) {
      const clash = await clashingWith(tx, tenantId, { resourceId: input.resourceId, startsAt: input.startsAt, endsAt });
      if (clash) {
        throw new CalendarError(
          `That time is already taken: ${clash.title} at ${clash.startsAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ })}.`,
          "clash",
          { id: clash.id, title: clash.title },
        );
      }
    }
    const phone = input.phone ? toE164(input.phone) : null;
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId,
        branchId: input.branchId ?? null,
        resourceId: input.resourceId ?? null,
        contactId: input.contactId ?? null,
        callId: input.callId ?? null,
        title: (input.title ?? input.personName ?? "Visit").slice(0, 120),
        kind: input.kind ?? "visit",
        status: input.status ?? "booked",
        startsAt: input.startsAt,
        endsAt,
        allDay: input.allDay ?? false,
        personName: input.personName ?? null,
        phoneE164: phone,
        notes: input.notes ?? null,
        source: input.source ?? "manual",
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })
      .returning();
    return row!;
  });
}

export async function updateAppointment(
  tenantId: string,
  id: string,
  patch: Partial<AppointmentInput> & { cancelledReason?: string },
  actorUserId: string | null,
  opts: { allowClash?: boolean } = {},
): Promise<Appointment> {
  return withTenant(tenantId, async (tx) => {
    const [current] = await tx.select().from(appointments).where(eq(appointments.id, id));
    if (!current) throw new CalendarError("That entry is no longer in the calendar.", "not_found");
    const startsAt = patch.startsAt ?? current.startsAt;
    const endsAt = patch.endsAt ?? (patch.startsAt || patch.minutes ? new Date(startsAt.getTime() + (patch.minutes ?? DEFAULT_MINUTES) * 60_000) : current.endsAt);
    if (!(endsAt.getTime() > startsAt.getTime())) throw new CalendarError("The end time has to be after the start.", "bad_time");
    const resourceId = patch.resourceId === undefined ? current.resourceId : patch.resourceId;
    if (!opts.allowClash && (patch.startsAt || patch.endsAt || patch.minutes || patch.resourceId !== undefined)) {
      const clash = await clashingWith(tx, tenantId, { resourceId, startsAt, endsAt, ignoreId: id });
      if (clash) throw new CalendarError(`That time is already taken: ${clash.title}.`, "clash", { id: clash.id });
    }
    const [row] = await tx
      .update(appointments)
      .set({
        ...(patch.title !== undefined ? { title: patch.title.slice(0, 120) } : {}),
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.personName !== undefined ? { personName: patch.personName } : {}),
        ...(patch.phone !== undefined ? { phoneE164: patch.phone ? toE164(patch.phone) : null } : {}),
        ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}),
        ...(patch.cancelledReason !== undefined ? { cancelledReason: patch.cancelledReason } : {}),
        resourceId,
        startsAt,
        endsAt,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(appointments.id, id))
      .returning();
    return row!;
  });
}

/** What a day looks like for the diary: the entries, and who is free. */
export async function dayView(tenantId: string, day: Date, filter: { resourceId?: string | null; branchId?: string | null } = {}) {
  const { from, to } = dayRange(day);
  const [items, people] = await Promise.all([listAppointments(tenantId, from, to, filter), listResources(tenantId)]);
  const byResource = people.map((r) => ({ resource: r, items: items.filter((i) => i.resourceId === r.id) }));
  return { day: from, items, people, byResource, unassigned: items.filter((i) => !i.resourceId) };
}

/** Counts per day for the month grid, so the calendar paints in one query. */
export async function monthCounts(tenantId: string, day: Date, filter: { resourceId?: string | null; branchId?: string | null } = {}) {
  const { from, to, weeks } = monthRange(day);
  const items = await listAppointments(tenantId, from, to, filter);
  const key = (d: Date) => {
    const p = localParts(d, TZ);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  };
  const map = new Map<string, typeof items>();
  for (const i of items) {
    const k = key(i.startsAt);
    map.set(k, [...(map.get(k) ?? []), i]);
  }
  return { weeks, byDay: map, items, key };
}

/**
 * A call that ended in a booking writes itself into the calendar. Called by the
 * analyser; one entry per call, so re-analysing never doubles the diary.
 */
export async function appointmentFromCall(
  tx: Tx,
  tenantId: string,
  input: { callId: string; contactId: string | null; branchId: string | null; when: Date; personName?: string | null; phone?: string | null; note?: string | null; clientProgramId?: string | null },
): Promise<Appointment | null> {
  const [existing] = await tx.select().from(appointments).where(eq(appointments.callId, input.callId));
  if (existing) return existing;
  const endsAt = new Date(input.when.getTime() + DEFAULT_MINUTES * 60_000);
  const [row] = await tx
    .insert(appointments)
    .values({
      tenantId,
      branchId: input.branchId,
      contactId: input.contactId,
      callId: input.callId,
      clientProgramId: input.clientProgramId ?? null,
      title: input.personName ? `${input.personName}` : "Visit booked on a call",
      kind: "visit",
      status: "booked",
      startsAt: input.when,
      endsAt,
      personName: input.personName ?? null,
      phoneE164: input.phone ?? null,
      notes: input.note ?? "Booked by the AI assistant on a call.",
      source: "call",
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** The next few visits for one person, for the contact and lead screens. */
export async function upcomingFor(tenantId: string, contactId: string, limit = 5) {
  return withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.contactId, contactId), gte(appointments.startsAt, new Date()), ne(appointments.status, "cancelled")))
      .orderBy(asc(appointments.startsAt))
      .limit(limit),
  );
}

/** Today at a glance, for the workspace overview. */
export async function todaySummary(tenantId: string, now = new Date()) {
  const { from, to } = dayRange(now);
  return withTenant(tenantId, async (tx) => {
    const [r] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        booked: sql<number>`count(*) filter (where ${appointments.status} in ('booked', 'confirmed'))::int`,
        done: sql<number>`count(*) filter (where ${appointments.status} = 'completed')::int`,
        noShow: sql<number>`count(*) filter (where ${appointments.status} = 'no_show')::int`,
        fromCalls: sql<number>`count(*) filter (where ${appointments.source} = 'call')::int`,
      })
      .from(appointments)
      .where(and(gte(appointments.startsAt, from), lt(appointments.startsAt, to), ne(appointments.status, "cancelled")));
    const next = await tx
      .select({ a: appointments, name: resources.name })
      .from(appointments)
      .leftJoin(resources, eq(resources.id, appointments.resourceId))
      .where(and(gte(appointments.startsAt, now), lt(appointments.startsAt, to), ne(appointments.status, "cancelled")))
      .orderBy(asc(appointments.startsAt))
      .limit(5);
    return { ...r!, next: next.map((n) => ({ ...n.a, resourceName: n.name })) };
  });
}

/** People, rooms and equipment the calendar books against. */
export async function saveResource(
  tenantId: string,
  input: { id?: string; name: string; kind?: Resource["kind"]; title?: string | null; colour?: string; branchId?: string | null; active?: boolean; workingHours?: Resource["workingHours"] },
  actorUserId: string | null,
): Promise<Resource> {
  return withTenant(tenantId, async (tx) => {
    if (input.id) {
      const [row] = await tx
        .update(resources)
        .set({
          name: input.name.trim().slice(0, 80),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.colour ? { colour: input.colour } : {}),
          ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.workingHours ? { workingHours: input.workingHours } : {}),
          updatedAt: new Date(),
        })
        .where(eq(resources.id, input.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(resources)
      .values({
        tenantId,
        name: input.name.trim().slice(0, 80),
        kind: input.kind ?? "doctor",
        title: input.title ?? null,
        colour: input.colour ?? "#C96A3C",
        branchId: input.branchId ?? null,
        workingHours: input.workingHours ?? {},
        createdBy: actorUserId,
      })
      .returning();
    return row!;
  });
}

/** Who a contact is, for writing a name and number onto an entry. */
export async function contactBrief(tx: Tx, tenantId: string, contactId: string) {
  const [c] = await tx.select({ name: contacts.name, phone: contacts.phoneE164, branchId: contacts.branchId }).from(contacts).where(eq(contacts.id, contactId));
  return c ?? null;
}

export { and, asc, desc, eq, gte, isNull, lte, or };
