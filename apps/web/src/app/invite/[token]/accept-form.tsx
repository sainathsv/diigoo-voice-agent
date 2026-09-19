"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/client";
import { acceptInvite, type InviteState } from "@/server/actions/invite";

export function AcceptForm({ token, email, name, signedIn }: { token: string; email: string; name: string; signedIn: boolean }) {
  const [state, action] = useActionState<InviteState, FormData>(acceptInvite, null);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      {state?.error ? <div className="notice notice-bad" role="alert">{state.error}</div> : null}
      {signedIn ? (
        <SubmitButton pendingText="Joining">Join the workspace</SubmitButton>
      ) : (
        <>
          <div>
            <span className="label">Email</span>
            <div className="input flex items-center bg-ivory-2 text-ink-soft">{email}</div>
          </div>
          <div>
            <label className="label" htmlFor="name">Your name</label>
            <input className="input" id="name" name="name" defaultValue={name} required autoComplete="name" />
          </div>
          <div>
            <label className="label" htmlFor="password">Choose a password</label>
            <input className="input" id="password" name="password" type="password" minLength={10} required autoComplete="new-password" />
            <p className="help">At least 10 characters.</p>
          </div>
          <div>
            <label className="label" htmlFor="confirm">Repeat password</label>
            <input className="input" id="confirm" name="confirm" type="password" minLength={10} required autoComplete="new-password" />
          </div>
          <SubmitButton pendingText="Creating your login">Create login and join</SubmitButton>
        </>
      )}
    </form>
  );
}
