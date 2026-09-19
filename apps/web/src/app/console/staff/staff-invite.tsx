"use client";

import { useActionState } from "react";
import { CopyField, SubmitButton } from "@/components/client";
import { inviteStaff, type ConsoleFormState } from "@/server/actions/console";

export function StaffInvite({ roles }: { roles: Array<{ id: string; name: string; description: string }> }) {
  const [state, action] = useActionState<ConsoleFormState, FormData>(inviteStaff, null);
  return (
    <form action={action} className="grid gap-4 px-5 py-4">
      {state?.error ? <div className="notice notice-bad" role="alert">{state.error}</div> : null}
      {state?.ok ? (
        <div className="notice notice-ok grid gap-3">
          <span>{state.ok}</span>
          {state.link ? <CopyField value={state.link} label="Invitation link" /> : null}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <div><label className="label" htmlFor="st-name">Name</label><input className="input" id="st-name" name="name" required minLength={2} /></div>
        <div><label className="label" htmlFor="st-email">Work email</label><input className="input" id="st-email" name="email" type="email" required /></div>
        <div>
          <label className="label" htmlFor="st-role">Role</label>
          <select className="input" id="st-role" name="roleId" required defaultValue="">
            <option value="" disabled>Choose</option>
            {roles.map((r) => <option key={r.id} value={r.id} title={r.description}>{r.name}</option>)}
          </select>
        </div>
      </div>
      <div><SubmitButton pendingText="Creating">Invite to Diigoo team</SubmitButton></div>
    </form>
  );
}
