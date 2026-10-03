import type { Metadata } from "next";
import { holdsAnywhere } from "@jenai/authz";
import { AutoRefresh, ConfirmButton, SubmitButton } from "@/components/client";
import { Flash, PageHead, Section, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { linkWhatsapp, retryWhatsappInbox, saveFormLink, unlinkWhatsapp } from "@/server/actions/cases";
import { loadWhatsappLink } from "@/server/queries/cases";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "WhatsApp" };

const STATUS: Record<string, string> = {
  created: "Not linked yet",
  initializing: "Starting up",
  qr_ready: "Waiting for the QR code to be scanned",
  authenticating: "Linking",
  ready: "Linked and working",
  disconnected: "Not linked (unlinked or disconnected)",
  action_required: "WhatsApp needs attention on the phone",
  failed: "Not working",
};

export default async function WhatsappPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "integrations:manage")) return deny(ctx, { perm: "integrations:manage" });
  const w = await loadWhatsappLink(ctx.org.id);
  const installed = w.channel?.mode === "openwa";
  const status = w.live?.status ?? w.channel?.linkStatus ?? (w.channel?.openwaSession ? null : "created");
  const waiting = status === "qr_ready" || status === "initializing" || status === "authenticating";
  const phone = w.live?.phone ? `+${w.live.phone.replace(/\D/g, "")}` : w.channel?.displayE164;

  return (
    <>
      <PageHead
        title="WhatsApp"
        sub="The police WhatsApp number that takes complaint details and proof. It runs through OpenWA on this server, so messages are not handled by Meta's cloud."
      />
      <Flash {...flash} />
      {waiting ? <AutoRefresh seconds={5} /> : null}

      <Section title="Police WhatsApp number">
        <div className="grid gap-4 px-5 py-4 text-[13.5px]">
          {!installed ? (
            <p>
              OpenWA is not installed on this server yet. Run <span className="font-mono">openwa-setup.sh</span> on the server, then come back to this page to link the number.
            </p>
          ) : (
            <>
              <div>
                <span className={`font-semibold ${status === "ready" ? "text-ok" : status === "failed" || status === "action_required" ? "text-bad" : ""}`}>{STATUS[status ?? ""] ?? status ?? "Unknown"}</span>
                {status === "ready" && phone ? <span> as <b className="font-mono">{phone}</b></span> : null}
                {w.error ? <div className="mt-1 text-bad">The gateway did not answer: {w.error}</div> : null}
                {w.live?.lastError && status !== "ready" ? <div className="mt-1 text-grey">Last error: {w.live.lastError}</div> : null}
              </div>
              {w.qr ? (
                <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
                  <img src={w.qr} alt="QR code to link the police WhatsApp number" className="h-[264px] w-[264px] rounded border border-line bg-white p-2" />
                  <ol className="list-decimal pl-5 text-[13px] leading-relaxed">
                    <li>On the police phone, open WhatsApp.</li>
                    <li>Go to Settings, then Linked devices, then Link a device.</li>
                    <li>Point the phone at this code. The page updates by itself once it is linked.</li>
                  </ol>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {status !== "ready" ? (
                  <form action={linkWhatsapp}>
                    <input type="hidden" name="slug" value={slug} />
                    <SubmitButton className="btn btn-dark" pendingText="Starting">{w.channel?.openwaSession ? "Show a new QR code" : "Link the WhatsApp number"}</SubmitButton>
                  </form>
                ) : (
                  <form action={unlinkWhatsapp}>
                    <input type="hidden" name="slug" value={slug} />
                    <ConfirmButton message="Unlink the police WhatsApp number? Complainants will get no messages until it is linked again.">Unlink the number</ConfirmButton>
                  </form>
                )}
              </div>
              <div className="text-[12.5px] text-grey">
                Messages waiting to be read: {w.queue.waiting}
                {w.queue.retrying ? <span> · {w.queue.retrying} being tried again</span> : null}
                {w.queue.stuck ? <span className="text-bad"> · {w.queue.stuck} could not be read</span> : null}
                {w.channel?.updatedAt ? <> · last change {fmtDate(w.channel.updatedAt)}</> : null}
                {w.queue.lastError && (w.queue.stuck || w.queue.retrying) ? <div className={w.queue.stuck ? "mt-1 text-bad" : "mt-1"}>Reason: {w.queue.lastError}</div> : null}
              </div>
              {w.queue.stuck ? (
                <form action={retryWhatsappInbox}>
                  <input type="hidden" name="slug" value={slug} />
                  <SubmitButton className="btn" pendingText="Queuing">Read them again</SubmitButton>
                </form>
              ) : null}
            </>
          )}
        </div>
      </Section>

      <div className="mt-6">
        <Section title="Complaint form link" sub="Sent on WhatsApp to complainants who lost no money (harassment, a hacked or fake profile, threats). Money frauds are asked the department's form question by question instead.">
          <form action={saveFormLink} className="flex flex-wrap items-end gap-2 px-5 py-4">
            <input type="hidden" name="slug" value={slug} />
            <div className="min-w-[280px] flex-1">
              <label className="label" htmlFor="form-url">Link to the cyber team's form</label>
              <input id="form-url" name="formUrl" type="url" defaultValue={w.channel?.formUrl ?? ""} placeholder="https://" className="input" />
            </div>
            <SubmitButton className="btn btn-dark">Save</SubmitButton>
          </form>
        </Section>
      </div>

      <div className="mt-6">
        <Section title="Keeping the number working">
          <ul className="list-disc px-10 py-4 text-[13px] leading-relaxed">
            <li>Use a SIM kept only for this helpline, never someone's personal number.</li>
            <li>Keep the phone charged and open WhatsApp on it at least once every few days: linked devices stop after about 14 days with the phone off.</li>
            <li>The helpline writes only to people who agreed on their call or who wrote first, one message at a time. Do not use this number for bulk messages: WhatsApp can restrict a number that does.</li>
          </ul>
        </Section>
      </div>
    </>
  );
}
