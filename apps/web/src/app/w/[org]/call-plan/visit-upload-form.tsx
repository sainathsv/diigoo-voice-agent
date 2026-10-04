"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/client";
import { uploadVisitList, type VisitUploadState } from "@/server/actions/visits";

/** The visit list upload: the result, and every row not used with the reason, stay on screen until the next upload. */
export function VisitUploadForm({ slug }: { slug: string }) {
  const [state, action] = useActionState<VisitUploadState, FormData>(uploadVisitList, null);
  const refused = state?.rejected ?? [];
  return (
    <form action={action} className="grid gap-4 px-5 py-4">
      <input type="hidden" name="slug" value={slug} />
      {state?.error ? <div className="notice notice-bad" role="alert">{state.error}</div> : null}
      {state?.ok ? <div className="notice notice-ok" role="status">{state.ok}</div> : null}
      {refused.length ? (
        <div>
          <div className="label">Rows not used, and why</div>
          <div className="tbl-wrap max-h-[320px] overflow-y-auto">
            <table className="tbl">
              <thead><tr><th className="num">Row</th><th>Why it was not used</th></tr></thead>
              <tbody>
                {refused.map((r, i) => (
                  <tr key={`${r.row}-${i}`}><td className="num">{r.row}</td><td>{r.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {state?.moreRejected ? <p className="help">{state.moreRejected.toLocaleString("en-IN")} more {state.moreRejected === 1 ? "row was" : "rows were"} not used and are not listed here.</p> : null}
        </div>
      ) : null}
      <div>
        <label className="label" htmlFor="visit-file">Visit list (CSV, up to 5 MB)</label>
        <input className="input" id="visit-file" name="file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" required />
        <p className="help">Needs mobile number, service and visit date. Also reads name, doctor, branch, session number and total sessions if present.</p>
        <p className="help">Export it from your billing or front-desk software. Uploading the same list again adds nothing twice. Nobody is called from here.</p>
      </div>
      <div><SubmitButton pendingText="Reading the list">Upload visit list</SubmitButton></div>
    </form>
  );
}
