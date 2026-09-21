import type { Metadata } from "next";
import Link from "next/link";
import { can, holdsAnywhere, maskPhone } from "@jenai/authz";
import { branches, withTenant } from "@jenai/db";
import { TZ, dayView, listResources, monthCounts } from "@jenai/engine";
import { Empty, Flash, PageHead, Section, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { addEntry, changeEntry, saveCalendarResource } from "@/server/actions/calendar";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Calendar" };

const KIND_LABEL: Record<string, string> = {
  visit: "Visit",
  follow_up: "Follow-up",
  procedure: "Procedure",
  call_back: "Call back",
  block: "Not available",
  other: "Other",
};
const STATUS_LABEL: Record<string, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  arrived: "Arrived",
  completed: "Done",
  cancelled: "Cancelled",
  no_show: "Did not come",
};

const iso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hhmm = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dayName = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "short", timeZone: TZ });
const monthName = (d: Date) => d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: TZ });
const shift = (d: Date, days: number) => new Date(d.getTime() + days * 24 * 3600 * 1000);

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ d?: string; view?: string; who?: string; ok?: string; error?: string }>;
}) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "calendar:view")) return deny(ctx, { perm: "calendar:view" });
  const mayEdit = can(ctx.access, "calendar:edit");
  const mayReveal = can(ctx.access, "contacts:reveal_phone");

  const today = new Date();
  const day = sp.d && /^\d{4}-\d{2}-\d{2}$/.test(sp.d) ? new Date(`${sp.d}T09:00:00+05:30`) : today;
  const view = sp.view === "month" || sp.view === "people" ? sp.view : "day";
  const who = sp.who && /^[0-9a-f-]{36}$/i.test(sp.who) ? sp.who : null;

  const [people, branchRows] = await Promise.all([
    listResources(ctx.org.id, true),
    withTenant(ctx.org.id, (tx) => tx.select({ id: branches.id, name: branches.name }).from(branches)),
  ]);
  const active = people.filter((p) => p.active);

  const link = (q: Record<string, string | null>) => {
    const params = new URLSearchParams({ d: iso(day), view, ...(who ? { who } : {}) });
    for (const [k, v] of Object.entries(q)) (v === null ? params.delete(k) : params.set(k, v));
    return `/w/${slug}/calendar?${params}`;
  };

  return (
    <>
      <PageHead
        title="Calendar"
        sub="Every visit, whoever it is with. Bookings made on a call land here on their own; anything else your team writes in."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className={`btn btn-sm ${view === "day" ? "btn-dark" : "btn-ghost"}`} href={link({ view: "day" })}>Day</Link>
            <Link className={`btn btn-sm ${view === "month" ? "btn-dark" : "btn-ghost"}`} href={link({ view: "month" })}>Month</Link>
            <Link className={`btn btn-sm ${view === "people" ? "btn-dark" : "btn-ghost"}`} href={link({ view: "people" })}>People and rooms</Link>
            <details className="relative">
              <summary className="btn btn-ghost btn-sm cursor-pointer list-none">Download</summary>
              <div className="card absolute right-0 z-10 mt-1 grid w-[236px] gap-1 p-2 text-[13px] shadow-sm">
                {(["day", "week", "month"] as const).map((r) => (
                  <div key={r} className="grid gap-1">
                    <div className="eyebrow px-1 pt-1">This {r}</div>
                    <div className="flex gap-1">
                      <a className="btn btn-ghost btn-sm flex-1" href={`/w/${slug}/calendar/report?d=${iso(day)}&range=${r}&format=html${who ? `&who=${who}` : ""}`} target="_blank" rel="noreferrer">Print or PDF</a>
                      <a className="btn btn-ghost btn-sm" href={`/w/${slug}/calendar/report?d=${iso(day)}&range=${r}&format=csv${who ? `&who=${who}` : ""}`}>Excel</a>
                      <a className="btn btn-ghost btn-sm" href={`/w/${slug}/calendar/report?d=${iso(day)}&range=${r}&format=ics${who ? `&who=${who}` : ""}`}>Calendar file</a>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      {view !== "people" ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link className="btn btn-ghost btn-sm" href={link({ d: iso(shift(day, view === "month" ? -28 : -1)) })}>&larr; {view === "month" ? "Previous" : "Yesterday"}</Link>
          <Link className="btn btn-ghost btn-sm" href={link({ d: iso(today) })}>Today</Link>
          <Link className="btn btn-ghost btn-sm" href={link({ d: iso(shift(day, view === "month" ? 28 : 1)) })}>{view === "month" ? "Next" : "Tomorrow"} &rarr;</Link>
          <span className="ml-1 font-semibold">{view === "month" ? monthName(day) : fmtDate(day, false)}</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Link className={`badge ${who ? "badge-muted" : "badge-copper"}`} href={link({ who: null })}>Everyone</Link>
            {active.map((p) => (
              <Link key={p.id} className={`badge ${who === p.id ? "badge-copper" : "badge-muted"}`} href={link({ who: p.id })}>
                <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: p.colour }} />
                {p.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {view === "day" ? <DayView slug={slug} day={day} who={who} mayEdit={mayEdit} mayReveal={mayReveal} tenantId={ctx.org.id} people={active} branches={branchRows} /> : null}
      {view === "month" ? <MonthView slug={slug} day={day} who={who} tenantId={ctx.org.id} /> : null}
      {view === "people" ? <PeopleView slug={slug} people={people} branches={branchRows} mayEdit={mayEdit} /> : null}
    </>
  );
}

async function DayView({
  slug,
  day,
  who,
  mayEdit,
  mayReveal,
  tenantId,
  people,
  branches: branchRows,
}: {
  slug: string;
  day: Date;
  who: string | null;
  mayEdit: boolean;
  mayReveal: boolean;
  tenantId: string;
  people: Array<{ id: string; name: string; colour: string; kind: string }>;
  branches: Array<{ id: string; name: string }>;
}) {
  const { items, byResource, unassigned } = await dayView(tenantId, day, { resourceId: who });
  const groups = who ? byResource.filter((g) => g.resource.id === who) : byResource;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-6">
        <Section title={`${items.length} in the day`} sub={items.length ? "Newest changes show at once. Times are India time." : undefined}>
          {items.length === 0 ? (
            <Empty>Nothing in the calendar for this day.</Empty>
          ) : (
            <div className="grid gap-4 px-5 py-4">
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <div key={g.resource.id}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: g.resource.colour }} />
                      <span className="font-semibold">{g.resource.name}</span>
                      {g.resource.title ? <span className="text-[12.5px] text-grey">{g.resource.title}</span> : null}
                      <span className="text-[12.5px] text-grey">· {g.items.length}</span>
                    </div>
                    <ul className="grid gap-1.5">
                      {g.items.map((a) => (
                        <EntryRow key={a.id} a={a} slug={slug} day={day} mayEdit={mayEdit} mayReveal={mayReveal} people={people} />
                      ))}
                    </ul>
                  </div>
                ))}
              {unassigned.length && !who ? (
                <div>
                  <div className="mb-1.5 font-semibold">Not assigned to anyone yet</div>
                  <ul className="grid gap-1.5">
                    {unassigned.map((a) => (
                      <EntryRow key={a.id} a={a} slug={slug} day={day} mayEdit={mayEdit} mayReveal={mayReveal} people={people} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </Section>
      </div>

      {mayEdit ? (
        <Section title="Add to this day" sub="A visit, a follow-up, leave, a camp: anything the day holds.">
          <form action={addEntry} className="grid gap-3 px-5 py-4">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="view" value="day" />
            <input type="hidden" name="date" value={iso(day)} />
            <div>
              <label className="label" htmlFor="personName">Who is it for</label>
              <input className="input" id="personName" name="personName" placeholder="Ravi Kumar" maxLength={80} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="time">Time</label>
                <input className="input" id="time" name="time" type="time" defaultValue="10:00" required />
              </div>
              <div>
                <label className="label" htmlFor="minutes">Minutes</label>
                <select className="input" id="minutes" name="minutes" defaultValue="30">
                  {[15, 20, 30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="resourceId">With</label>
                <select className="input" id="resourceId" name="resourceId" defaultValue="">
                  <option value="">Not decided</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="kind">What</label>
                <select className="input" id="kind" name="kind" defaultValue="visit">
                  {Object.entries(KIND_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="phone">Phone</label>
                <input className="input" id="phone" name="phone" placeholder="98765 43210" maxLength={20} />
              </div>
              <div>
                <label className="label" htmlFor="branchId">Branch</label>
                <select className="input" id="branchId" name="branchId" defaultValue="">
                  <option value="">All</option>
                  {branchRows.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="notes">Note</label>
              <input className="input" id="notes" name="notes" placeholder="Laser session, came through a call" maxLength={500} />
            </div>
            <SubmitButton className="btn btn-primary" pendingText="Adding">Add to calendar</SubmitButton>
          </form>
        </Section>
      ) : null}
    </div>
  );
}

function EntryRow({
  a,
  slug,
  day,
  mayEdit,
  mayReveal,
  people,
}: {
  a: { id: string; title: string; kind: string; status: string; startsAt: Date; endsAt: Date; personName: string | null; phoneE164: string | null; notes: string | null; source: string; resourceColour?: string | null };
  slug: string;
  day: Date;
  mayEdit: boolean;
  mayReveal: boolean;
  people: Array<{ id: string; name: string }>;
}) {
  const cancelled = a.status === "cancelled";
  return (
    <li className={`rounded-xl border border-line px-3 py-2.5 ${cancelled ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-[84px] font-semibold tabular-nums">{hhmm(a.startsAt)}</span>
        <span className="font-semibold">{a.personName ?? a.title}</span>
        <span className="badge badge-muted">{KIND_LABEL[a.kind] ?? a.kind}</span>
        <span className={`badge ${a.status === "completed" ? "badge-ok" : a.status === "no_show" || cancelled ? "badge-bad" : "badge-copper"}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
        {a.source === "call" ? <span className="badge badge-muted">from a call</span> : null}
        <span className="text-[12.5px] text-grey">
          {a.phoneE164 ? (mayReveal ? a.phoneE164 : maskPhone(a.phoneE164)) : ""}
          {a.notes ? ` · ${a.notes}` : ""}
        </span>
      </div>
      {mayEdit && !cancelled ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[12.5px] font-semibold text-copper-deep">Change</summary>
          <form action={changeEntry} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="id" value={a.id} />
            <input type="hidden" name="back" value={iso(day)} />
            <div>
              <label className="label" htmlFor={`d-${a.id}`}>Move to</label>
              <input className="input h-9 w-[150px]" id={`d-${a.id}`} name="date" type="date" defaultValue={iso(a.startsAt)} />
            </div>
            <div>
              <label className="label" htmlFor={`t-${a.id}`}>Time</label>
              <input className="input h-9 w-[110px]" id={`t-${a.id}`} name="time" type="time" defaultValue={new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ, hour12: false }).format(a.startsAt)} />
            </div>
            <div>
              <label className="label" htmlFor={`w-${a.id}`}>With</label>
              <select className="input h-9 w-[150px]" id={`w-${a.id}`} name="resourceId" defaultValue="">
                <option value="">Leave as is</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <SubmitButton className="btn btn-ghost btn-sm">Save</SubmitButton>
            <button className="btn btn-ghost btn-sm" name="status" value="confirmed">Confirmed</button>
            <button className="btn btn-ghost btn-sm" name="status" value="arrived">Arrived</button>
            <button className="btn btn-dark btn-sm" name="status" value="completed">Done</button>
            <button className="btn btn-ghost btn-sm" name="status" value="no_show">Did not come</button>
            <button className="btn btn-danger btn-sm" name="status" value="cancelled">Cancel</button>
          </form>
        </details>
      ) : null}
    </li>
  );
}

async function MonthView({ slug, day, who, tenantId }: { slug: string; day: Date; who: string | null; tenantId: string }) {
  const { weeks, byDay, key, items } = await monthCounts(tenantId, day, { resourceId: who });
  const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "2-digit" }).format(day);
  const todayKey = key(new Date());

  return (
    <Section title={`${items.length} in ${monthName(day)}`} sub="Click a day to open it.">
      <div className="px-5 py-4">
        <div className="grid grid-cols-7 gap-1.5 text-[12px] font-semibold text-grey">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="px-1 pb-1">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {weeks.flat().map((d) => {
            const k = key(d);
            const list = byDay.get(k) ?? [];
            const outside = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "2-digit" }).format(d) !== thisMonth;
            return (
              <Link
                key={k}
                href={`/w/${slug}/calendar?d=${k}&view=day${who ? `&who=${who}` : ""}`}
                className={`min-h-[92px] rounded-xl border p-2 transition ${k === todayKey ? "border-copper bg-copper-wash" : "border-line bg-paper"} ${outside ? "opacity-45" : ""} hover:border-ink`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold">{new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric" }).format(d)}</span>
                  {list.length ? <span className="badge badge-copper">{list.length}</span> : null}
                </div>
                <div className="mt-1 grid gap-0.5">
                  {list.slice(0, 3).map((a) => (
                    <div key={a.id} className="truncate text-[11.5px]">
                      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: a.resourceColour ?? "#7C7671" }} />
                      {hhmm(a.startsAt)} {a.personName ?? a.title}
                    </div>
                  ))}
                  {list.length > 3 ? <div className="text-[11px] text-grey">and {list.length - 3} more</div> : null}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function PeopleView({
  slug,
  people,
  branches: branchRows,
  mayEdit,
}: {
  slug: string;
  people: Array<{ id: string; name: string; kind: string; title: string | null; colour: string; active: boolean; branchId: string | null }>;
  branches: Array<{ id: string; name: string }>;
  mayEdit: boolean;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Section title="People and rooms" sub="Whoever visits are booked with: doctors, therapists, rooms, machines.">
        {people.length === 0 ? (
          <Empty>None added yet. Add your doctors on the right.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Name</th><th>What</th><th>Branch</th><th>In use</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: p.colour }} />
                      <span className="font-semibold">{p.name}</span>
                      {p.title ? <span className="ml-2 text-[12.5px] text-grey">{p.title}</span> : null}
                    </td>
                    <td className="capitalize">{p.kind}</td>
                    <td>{branchRows.find((b) => b.id === p.branchId)?.name ?? "All"}</td>
                    <td>{p.active ? <span className="badge badge-ok">yes</span> : <span className="badge badge-muted">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {mayEdit ? (
        <Section title="Add a person or a room">
          <form action={saveCalendarResource} className="grid gap-3 px-5 py-4">
            <input type="hidden" name="slug" value={slug} />
            <div>
              <label className="label" htmlFor="r-name">Name</label>
              <input className="input" id="r-name" name="name" placeholder="Dr Rickson Pereira" required minLength={2} maxLength={80} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="r-kind">What is it</label>
                <select className="input" id="r-kind" name="kind" defaultValue="doctor">
                  <option value="doctor">Doctor</option>
                  <option value="staff">Staff member</option>
                  <option value="room">Room</option>
                  <option value="equipment">Machine</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="r-colour">Colour</label>
                <input className="input h-[38px] p-1" id="r-colour" name="colour" type="color" defaultValue="#C96A3C" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="r-title">Title (optional)</label>
                <input className="input" id="r-title" name="title" placeholder="Dermatologist" maxLength={60} />
              </div>
              <div>
                <label className="label" htmlFor="r-branch">Branch</label>
                <select className="input" id="r-branch" name="branchId" defaultValue="">
                  <option value="">All</option>
                  {branchRows.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <SubmitButton className="btn btn-primary" pendingText="Saving">Add</SubmitButton>
          </form>
        </Section>
      ) : null}
    </div>
  );
}
