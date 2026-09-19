import Link from "next/link";

export function Logo({ suffix }: { suffix?: string }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="h-display text-[22px]">
        jen<span className="text-copper">ai</span>
        <span className="text-copper">.</span>
      </span>
      {suffix ? <span className="eyebrow">{suffix}</span> : null}
    </span>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="h-display text-[26px]">{title}</h1>
        {sub ? <p className="mt-1.5 max-w-[70ch] text-ink-soft">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, sub, children, actions }: { title: string; sub?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="h-display text-[17px]">{title}</h2>
          {sub ? <p className="mt-1 text-[13px] text-grey">{sub}</p> : null}
        </div>
        {actions}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-8 text-center text-grey">{children}</div>;
}

const STATUS_TONE: Record<string, string> = {
  active: "badge-ok",
  passed: "badge-ok",
  approved: "badge-ok",
  accepted: "badge-ok",
  onboarding: "badge-copper",
  in_progress: "badge-copper",
  requested: "badge-copper",
  pending: "badge-muted",
  invited: "badge-muted",
  skipped: "badge-muted",
  expired: "badge-muted",
  suspended: "badge-bad",
  failed: "badge-bad",
  denied: "badge-bad",
  revoked: "badge-bad",
  closed: "badge-bad",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? "badge-muted"}`}>{status.replace(/_/g, " ")}</span>;
}

export function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  const o = Array.isArray(ok) ? ok[0] : ok;
  const e = Array.isArray(error) ? error[0] : error;
  if (!o && !e) return null;
  return <div className={`notice mb-5 ${e ? "notice-bad" : "notice-ok"}`} role="status">{e ?? o}</div>;
}

export function TextLink(props: React.ComponentProps<typeof Link>) {
  return <Link {...props} className={`font-semibold text-copper-deep underline-offset-2 hover:underline ${props.className ?? ""}`} />;
}

export function fmtDate(d: Date | string | null | undefined, withTime = true) {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ivory-2 text-[12px] font-bold text-ink-soft" aria-hidden>
      {initials(name)}
    </span>
  );
}
