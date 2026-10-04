/**
 * Errors safe to keep, log or show. A failed query wrapped by Drizzle carries
 * the whole statement and every parameter in its message (0.45:
 * "Failed query: ...\nparams: ..."), which for a visit list or a CRM read is
 * people's names, numbers and treatments. Only Postgres's code for it
 * (SQLSTATE, such as 40P01 for a deadlock) leaves here.
 */

/** Postgres's code for a failed query (SQLSTATE), "unknown" when it gave none, or null when the error is not a query's. */
export function dbErrorCode(e: unknown): string | null {
  if (!isQueryError(e)) return null;
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  const code = err.cause?.code ?? err.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
}

/** Drizzle's wrapper around a failed query, or the driver's own error. */
function isQueryError(e: unknown): boolean {
  const err = e as Record<string, unknown> | null;
  return !!err && typeof err === "object" && (("query" in err && "params" in err) || "severity" in err);
}

/**
 * An error's message, safe to store in last_pull_error, write to a log or
 * show a clinic: a failed query becomes "the database refused it (code)",
 * never its statement or values.
 */
export function errorText(e: unknown): string {
  if (isQueryError(e)) return `the database refused it (${dbErrorCode(e)})`;
  return e instanceof Error ? e.message : String(e);
}
