"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { CopyField, SubmitButton } from "@/components/client";
import { createClient, type ConsoleFormState } from "@/server/actions/console";

const VERTICALS: Array<[string, string]> = [
  ["dental", "Dental clinic"],
  ["derma", "Skin, hair or cosmetic clinic"],
  ["hospital", "Hospital"],
  ["municipal", "Municipal or government body"],
  ["spa", "Spa or salon"],
  ["gym", "Gym or fitness"],
  ["restaurant", "Restaurant"],
  ["home_services", "Home services"],
  ["other", "Other"],
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export function NewClientForm() {
  const [state, action] = useActionState<ConsoleFormState, FormData>(createClient, null);
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);

  if (state?.ok && state.link) {
    return (
      <div className="grid gap-4 px-5 py-5">
        <div className="notice notice-ok">{state.ok}</div>
        <CopyField value={state.link} label="Owner invitation link (valid 7 days)" />
        <div className="flex gap-2">
          <Link className="btn btn-primary" href={`/console/clients/${state.clientId}`}>Open go-live checklist</Link>
          <Link className="btn btn-ghost" href="/console">Back to clients</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="grid gap-5 px-5 py-5">
      {state?.error ? <div className="notice notice-bad" role="alert">{state.error}</div> : null}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="eyebrow mb-3">Business</legend>
        <div>
          <label className="label" htmlFor="c-name">Business name</label>
          <input className="input" id="c-name" name="name" required minLength={2} onChange={(e) => !touched && setSlug(slugify(e.target.value))} placeholder="Sri Sai Dental Care" />
        </div>
        <div>
          <label className="label" htmlFor="c-slug">Workspace address</label>
          <div className="flex items-center gap-1.5">
            <span className="text-grey">/w/</span>
            <input className="input font-mono" id="c-slug" name="slug" required value={slug} onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="c-vertical">Type of business</label>
          <select className="input" id="c-vertical" name="vertical" defaultValue="dental">
            {VERTICALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="c-plan">Plan</label>
          <select className="input" id="c-plan" name="plan" defaultValue="trial">
            <option value="trial">Trial</option>
            <option value="front_desk">Front Desk (₹2,999/mo)</option>
            <option value="growth">Growth (₹7,999/mo per branch)</option>
            <option value="business">Business (₹19,999/mo)</option>
            <option value="enterprise">Enterprise / Government</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="c-city">City</label>
          <input className="input" id="c-city" name="city" defaultValue="Hyderabad" />
        </div>
        <div>
          <label className="label" htmlFor="c-branch">First branch</label>
          <input className="input" id="c-branch" name="branch" required minLength={2} placeholder="Kondapur" />
        </div>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="eyebrow mb-3">Owner</legend>
        <div>
          <label className="label" htmlFor="c-owner">Owner name</label>
          <input className="input" id="c-owner" name="ownerName" required minLength={2} />
        </div>
        <div>
          <label className="label" htmlFor="c-owner-email">Owner email</label>
          <input className="input" id="c-owner-email" name="ownerEmail" type="email" required />
          <p className="help">They get an invitation to set their own password, then invite their team.</p>
        </div>
      </fieldset>
      <div><SubmitButton pendingText="Creating workspace">Create workspace</SubmitButton></div>
    </form>
  );
}
