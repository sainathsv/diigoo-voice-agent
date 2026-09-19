import type { AgentSafetyCheck, AgentVersion } from "@jenai/db";
import { GUARDRAILS_VERSION, guardrailsVersionOf } from "@jenai/voice";
import { StatusBadge, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { runSafetyCheckNow } from "@/server/actions/modules";

interface CaseRow {
  id: string;
  severity: "critical" | "high" | "medium";
  verdict: "held" | "failed" | "review";
  reason: string;
  greeting: string;
  turns: Array<{ caller: string; agent: string }>;
}

const LABEL: Record<string, string> = {
  prompt_leak_direct: "Keeps its instructions private",
  prompt_leak_developer: "Resists someone posing as JENAI staff",
  prompt_leak_hindi: "Keeps instructions private (Hindi)",
  prompt_leak_telugu: "Keeps instructions private (Telugu)",
  ai_disclosure: "Says it is an AI when asked",
  ai_disclosure_telugu: "Says it is an AI when asked (Telugu)",
  emergency: "Sends emergencies to 112 / 108 first",
  other_person_data: "Never shares another person's details",
  roleplay_jailbreak: "Refuses role-play jailbreaks",
  injection_in_name: "Ignores instructions hidden in caller speech",
  sensitive_data_request: "Never collects Aadhaar, bank or card details",
  invented_price: "Never invents prices",
  unauthorized_commitment: "Never promises unlisted discounts",
  political_opinion: "No political opinions",
  competitor_disparagement: "No remarks about competitors",
  abusive_caller: "Stays calm with abusive callers",
  medical_advice: "No medicines or doses",
  diagnosis_request: "No diagnoses",
  bribe_fast_track: "Refuses bribes and shortcuts",
  official_promise: "No promises of deadlines or outcomes",
};

const STATUS_TEXT: Record<AgentSafetyCheck["status"], string> = {
  queued: "Waiting to start",
  running: "Running now (about 2 minutes)",
  passed: "Passed",
  failed: "Failed: cannot go live",
  needs_review: "A JENAI reviewer is reading some answers",
  error: "Could not run: start it again",
};

/** The AI red-team result for one version, with the conversations that failed. */
export function SafetyPanel({ slug, version, check, canRun }: { slug: string; version: AgentVersion; check: AgentSafetyCheck | null; canRun: boolean }) {
  const results = (check?.results ?? []) as CaseRow[];
  const problems = results.filter((r) => r.verdict !== "held");
  const legacy = ["imported", "live", "superseded"].includes(version.state) && guardrailsVersionOf(version.inboundPrompt ?? "") === null;
  const stale = check && version.promptHash && check.promptHash !== version.promptHash;

  return (
    <div className="grid gap-3 rounded-xl border border-line px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow">AI safety check</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {check ? <StatusBadge status={check.status} /> : <span className="badge badge-muted">not checked</span>}
            <span className="text-[13px] text-ink-soft">
              {check ? STATUS_TEXT[check.status] : "Callers try 16 to 18 known tricks on this version before it can go live."}
              {check?.finishedAt && ["passed", "failed", "needs_review"].includes(check.status) ? ` · ${check.held} of ${results.length} held · ${fmtDate(check.finishedAt)}` : ""}
            </span>
          </div>
        </div>
        {canRun ? (
          <form action={runSafetyCheckNow}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="versionId" value={version.id} />
            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Starting">{check ? "Check again" : "Run safety check"}</SubmitButton>
          </form>
        ) : null}
      </div>

      {legacy ? (
        <div className="notice notice-bad">
          This version has no JENAI safety rules (current rules are v{GUARDRAILS_VERSION}). Publishing any new version adds them for inbound and outbound calls.
        </div>
      ) : null}
      {stale ? <div className="notice notice-warn">The last check was for an earlier wording. Run it again for this version.</div> : null}
      {check?.reviewedBy && check.reviewNote ? <div className="text-[12.5px] text-ink-soft">JENAI review: {check.reviewNote}</div> : null}

      {problems.length ? (
        <ul className="grid gap-2">
          {problems.map((r) => (
            <li key={r.id} className="rounded-lg bg-ivory px-3 py-2">
              <details>
                <summary className="cursor-pointer">
                  <span className={`badge mr-2 ${r.verdict === "failed" ? "badge-bad" : "badge-copper"}`}>{r.verdict === "failed" ? r.severity : "review"}</span>
                  <span className="font-semibold">{LABEL[r.id] ?? r.id.replace(/_/g, " ")}</span>
                </summary>
                <div className="mt-2 grid gap-1.5 text-[13px]">
                  <p className="text-ink-soft">{r.reason}</p>
                  <p><span className="font-semibold">Agent:</span> {r.greeting}</p>
                  {r.turns.map((t, i) => (
                    <div key={i} className="grid gap-1">
                      <p><span className="font-semibold">Caller:</span> {t.caller}</p>
                      <p><span className="font-semibold">Agent:</span> {t.agent}</p>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
