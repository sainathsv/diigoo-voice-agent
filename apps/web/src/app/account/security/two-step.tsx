"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";

type Stage =
  | { name: "idle" }
  | { name: "scan"; uri: string; secret: string; qr: string; codes: string[] }
  | { name: "codes"; codes: string[] };

/** Turn two-step sign-in on (scan, confirm a code, save backup codes) or off. */
export function TwoStepPanel({ enabled, required }: { enabled: boolean; required: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(password: string) {
    setError(null);
    setPending(true);
    const { data, error } = await authClient.twoFactor.enable({ password, issuer: "JENAI" });
    setPending(false);
    if (error || !data || !("totpURI" in data) || !data.totpURI) {
      setError(error?.status === 400 ? "That password is not right." : "Could not start set-up. Try again.");
      return;
    }
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    const qr = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200, errorCorrectionLevel: "M" });
    setStage({ name: "scan", uri: data.totpURI, secret, qr, codes: data.backupCodes ?? [] });
  }

  async function confirm(code: string, codes: string[]) {
    setError(null);
    setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") });
    setPending(false);
    if (error) {
      setError("That code is wrong or has expired. Enter the code showing in the app now.");
      return;
    }
    setStage({ name: "codes", codes });
  }

  async function turnOff(password: string) {
    setError(null);
    setPending(true);
    const { error } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (error) {
      setError(error.status === 400 ? "That password is not right." : "Could not turn it off. Try again.");
      return;
    }
    router.refresh();
  }

  async function newCodes(password: string) {
    setError(null);
    setPending(true);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setPending(false);
    if (error || !data) {
      setError(error?.status === 400 ? "That password is not right." : "Could not make new codes. Try again.");
      return;
    }
    setStage({ name: "codes", codes: data.backupCodes });
  }

  const err = error ? <div className="notice notice-bad" role="alert">{error}</div> : null;

  if (stage.name === "codes") {
    return (
      <div className="grid gap-4 px-5 py-5">
        <div className="notice notice-ok" role="status">
          Two-step sign-in is on. Save these backup codes somewhere safe, away from your phone. Each one works once if you lose the phone. They will not be shown again.
        </div>
        <ul className="grid max-w-[420px] grid-cols-2 gap-2 font-mono text-[14px]">
          {stage.codes.map((c) => (
            <li key={c} className="rounded-lg border border-line bg-ivory px-3 py-1.5 text-center">{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(stage.codes.join("\n"))}>Copy codes</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { setStage({ name: "idle" }); router.refresh(); }}>I have saved them</button>
        </div>
      </div>
    );
  }

  if (stage.name === "scan") {
    return (
      <div className="grid gap-5 px-5 py-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={stage.qr} alt="QR code to add JENAI to your authenticator app" width={200} height={200} className="rounded-lg border border-line bg-white" />
        </div>
        <form
          className="grid content-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm(String(new FormData(e.currentTarget).get("code") ?? ""), stage.codes);
          }}
        >
          {err}
          <ol className="grid list-decimal gap-1.5 pl-5 text-ink-soft">
            <li>Open Google Authenticator, Microsoft Authenticator, 1Password or any authenticator app.</li>
            <li>Scan the code. If you cannot scan, add a key by hand: <span className="break-all font-mono text-[12.5px] text-ink">{stage.secret}</span></li>
            <li>Enter the 6-digit code the app shows for JENAI.</li>
          </ol>
          <div className="max-w-[220px]">
            <label className="label" htmlFor="setup-code">6-digit code</label>
            <input className="input font-mono tracking-[0.2em]" id="setup-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={pending}>{pending ? "Checking" : "Turn on"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStage({ name: "idle" })}>Cancel</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="grid gap-4 px-5 py-5">
      {err}
      <p className="max-w-[62ch] text-ink-soft">
        {enabled
          ? "On. Signing in needs your password and a code from your authenticator app."
          : required
            ? "Required for Diigoo staff. Until it is on, the console stays closed to you."
            : "Off. Turn it on so a stolen password alone cannot open your account."}
      </p>
      <PasswordForm
        id={enabled ? "off" : "on"}
        label={enabled ? "Turn off" : "Set up two-step sign-in"}
        tone={enabled ? "btn-danger" : "btn-primary"}
        pending={pending}
        onSubmit={enabled ? turnOff : start}
      />
      {enabled ? <PasswordForm id="codes" label="Make new backup codes" tone="btn-ghost" pending={pending} onSubmit={newCodes} /> : null}
    </div>
  );
}

function PasswordForm({ id, label, tone, pending, onSubmit }: { id: string; label: string; tone: string; pending: boolean; onSubmit: (password: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div>
        <button type="button" className={`btn btn-sm ${tone}`} onClick={() => setOpen(true)}>{label}</button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(String(new FormData(e.currentTarget).get("password") ?? ""));
      }}
    >
      <div className="min-w-[220px] flex-1 sm:max-w-[280px]">
        <label className="label" htmlFor={`pw-${id}`}>Confirm your password</label>
        <input className="input" id={`pw-${id}`} name="password" type="password" autoComplete="current-password" required autoFocus />
      </div>
      <button className={`btn btn-sm ${tone}`} disabled={pending}>{pending ? "Working" : label}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
