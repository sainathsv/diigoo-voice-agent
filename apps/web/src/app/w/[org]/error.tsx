"use client";

import Link from "next/link";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const denied = /Missing permission|suspended/i.test(error.message);
  return (
    <div className="card card-pad max-w-[560px]">
      <h1 className="h-display text-[20px]">{denied ? "You don't have access to do that" : "Something went wrong"}</h1>
      <p className="mt-2 text-ink-soft">
        {denied
          ? "Your role does not allow this action here. Ask an Owner or Admin in your workspace if you need it."
          : "The action did not complete. Nothing was changed. Try again, and contact JENAI support if it keeps happening."}
      </p>
      {error.digest ? <p className="mt-2 font-mono text-[12px] text-grey">Reference {error.digest}</p> : null}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-ghost" onClick={reset} type="button">Try again</button>
        <Link className="btn btn-dark" href="/">Go to my workspace</Link>
      </div>
    </div>
  );
}
