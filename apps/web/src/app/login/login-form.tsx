"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { toLoginEmail } from "@jenai/authz";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState<"password" | "code">("password");
  const [useBackup, setUseBackup] = useState(false);

  const done = () => {
    router.replace(next);
    router.refresh();
  };

  if (step === "code") {
    return (
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s+/g, "");
          setPending(true);
          setError(null);
          const { error } = useBackup
            ? await authClient.twoFactor.verifyBackupCode({ code })
            : await authClient.twoFactor.verifyTotp({ code });
          setPending(false);
          if (error) {
            setError(
              error.status === 429 || /lock/i.test(error.message ?? "")
                ? "Too many wrong codes. Sign in again in a few minutes."
                : useBackup
                  ? "That backup code is wrong or already used."
                  : "That code is wrong or has expired. Codes change every 30 seconds.",
            );
            return;
          }
          done();
        }}
      >
        {error ? <div className="notice notice-bad" role="alert">{error}</div> : null}
        <p className="text-ink-soft">
          {useBackup ? "Enter one of the backup codes you saved when you set up two-step sign-in. Each works once." : "Open your authenticator app and enter the 6-digit code for JENAI."}
        </p>
        <div>
          <label className="label" htmlFor="code">{useBackup ? "Backup code" : "6-digit code"}</label>
          <input
            className="input font-mono tracking-[0.2em]"
            id="code"
            name="code"
            inputMode={useBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            pattern={useBackup ? undefined : "[0-9 ]{6,7}"}
            maxLength={useBackup ? 24 : 7}
            required
            autoFocus
          />
        </div>
        <button className="btn btn-primary h-10" type="submit" disabled={pending}>
          {pending ? "Checking" : "Continue"}
        </button>
        <button
          type="button"
          className="text-left text-[13px] font-semibold text-copper-deep"
          onClick={() => {
            setUseBackup(!useBackup);
            setError(null);
          }}
        >
          {useBackup ? "Use the authenticator app instead" : "Lost your phone? Use a backup code"}
        </button>
      </form>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const { data, error } = await authClient.signIn.email({
          // A username signs in too: it resolves to the same account underneath.
          email: toLoginEmail(String(fd.get("email") ?? "")),
          password: String(fd.get("password") ?? ""),
        });
        setPending(false);
        if (error) {
          setError(error.status === 429 ? "Too many attempts. Wait a minute and try again." : "That username or email and password do not match.");
          return;
        }
        if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
          setStep("code");
          return;
        }
        done();
      }}
    >
      {error ? <div className="notice notice-bad" role="alert">{error}</div> : null}
      <div>
        <label className="label" htmlFor="email">Username or work email</label>
        <input className="input" id="email" name="email" type="text" inputMode="email" autoComplete="username" required autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required minLength={10} />
      </div>
      <button className="btn btn-primary h-10" type="submit" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
