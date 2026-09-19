"use client";

import { useActionState } from "react";
import { CopyField, SubmitButton } from "@/components/client";
import { inviteMember, type FormState } from "@/server/actions/workspace";

export function InviteForm({
  slug,
  roles,
  branches,
}: {
  slug: string;
  roles: Array<{ id: string; name: string; defaultScope: string; description: string }>;
  branches: Array<{ id: string; name: string }>;
}) {
  const [state, action] = useActionState<FormState, FormData>(inviteMember, null);
  return (
    <form action={action} className="grid gap-4 px-5 py-4">
      <input type="hidden" name="slug" value={slug} />
      {state?.error ? <div className="notice notice-bad" role="alert">{state.error}</div> : null}
      {state?.ok ? (
        <div className="notice notice-ok grid gap-3" role="status">
          <span>{state.ok}</span>
          {state.link ? <CopyField value={state.link} label="Invitation link" /> : null}
          <span className="text-[12px]">Email delivery switches on once JENAI's email service is live; until then, share the link on WhatsApp or email.</span>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="inv-name">Name</label>
          <input className="input" id="inv-name" name="name" placeholder="Priya Reddy" />
        </div>
        <div>
          <label className="label" htmlFor="inv-email">Work email</label>
          <input className="input" id="inv-email" name="email" type="email" required placeholder="priya@clinic.in" />
        </div>
        <div>
          <label className="label" htmlFor="inv-role">Role</label>
          <select className="input" id="inv-role" name="roleId" required defaultValue="">
            <option value="" disabled>Choose a role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}{r.defaultScope === "branch" ? " (per branch)" : ""}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="inv-branch">Branch</label>
          <select className="input" id="inv-branch" name="branchId" defaultValue="">
            <option value="">Whole organization</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <p className="help">Front desk, branch managers and doctors work in one branch.</p>
        </div>
      </div>
      <div><SubmitButton pendingText="Creating invitation">Create invitation</SubmitButton></div>
    </form>
  );
}
