"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const { error } = await authClient.signIn.email({
          email: String(fd.get("email") ?? "").trim(),
          password: String(fd.get("password") ?? ""),
        });
        setPending(false);
        if (error) {
          setError(error.status === 429 ? "Too many attempts. Wait a minute and try again." : "Email or password is incorrect.");
          return;
        }
        router.replace(next);
        router.refresh();
      }}
    >
      {error ? <div className="notice notice-bad" role="alert">{error}</div> : null}
      <div>
        <label className="label" htmlFor="email">Work email</label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" required autoFocus />
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
