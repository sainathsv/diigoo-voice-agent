import { assertClientUrl } from "@jenai/voice";
import { applyMapping, retryable, type Connector, type ConnectorContext, type OutEvent, type SendResult } from "./types";

/**
 * Zoho CRM. The client keeps running Zoho exactly as they do today; JENAI adds
 * a note to the right record after every call, updates the fields they choose,
 * and can create a follow-up task. We never copy their database out.
 *
 * Setup on their side: a Self Client or server-based app in the Zoho API
 * console, scopes ZohoCRM.modules.ALL and ZohoCRM.settings.READ, and the
 * refresh token pasted into JENAI. Data centre matters: India accounts use
 * .in, others .com, .eu, .com.au, .jp.
 */

export const ACCOUNTS: Record<string, string> = {
  in: "https://accounts.zoho.in",
  com: "https://accounts.zoho.com",
  eu: "https://accounts.zoho.eu",
  au: "https://accounts.zoho.com.au",
  jp: "https://accounts.zoho.jp",
};
export const API: Record<string, string> = {
  in: "https://www.zohoapis.in",
  com: "https://www.zohoapis.com",
  eu: "https://www.zohoapis.eu",
  au: "https://www.zohoapis.com.au",
  jp: "https://www.zohoapis.jp",
};

const dcOf = (ctx: ConnectorContext) => String(ctx.integration.config.dc ?? "in").toLowerCase();
const moduleOf = (ctx: ConnectorContext) => String(ctx.integration.config.module ?? "Leads");

/**
 * What the client's Zoho admin actually granted, recorded when the connection
 * was made. A CRM admin grants the narrowest set they are comfortable with, and
 * a connector that assumes more fails on the first real call with a permission
 * error that reads like our bug. So we write what we are allowed to write, and
 * say plainly what we skipped.
 */
function granted(ctx: ConnectorContext): Set<string> {
  const raw = ctx.integration.config.scopes;
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}
/** Unknown scopes (an older connection recorded none) means assume allowed, as before. */
const may = (ctx: ConnectorContext, scope: string) => {
  const g = granted(ctx);
  return g.size === 0 || g.has(scope);
};

/**
 * Zoho wants a wall-clock time with an offset, and a duration it refuses at
 * zero ("Call Duration can not be zero"), so a call too short to time counts
 * as one second.
 *
 * Zoho's own pages disagree on the duration's format: the API reference says
 * HH:mm (with "10:00" as its sample), the CRM help says it is entered in
 * minutes and seconds. We send minutes and seconds, the way the CRM shows it.
 * If the reference is the right one, Zoho refuses the Call (a start plus that
 * many hours is after now) and the skipped event carries its reason. Sent as
 * HH:mm and wrong, every call would land sixty times too short, silently.
 */
function callTimes(p: Record<string, unknown>): { start: string; duration: string } {
  const c = (p.call ?? {}) as Record<string, unknown>;
  const at = new Date(String(c.at ?? c.started_at ?? new Date().toISOString()));
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 19);
  const secs = Math.max(1, Math.round(Number(c.seconds) || 0));
  return { start: `${ist}+05:30`, duration: `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}` };
}

/**
 * How a Call points at its record. Zoho's Who_Id is always a Contact; a Lead,
 * or any other module, goes in What_Id with $se_module naming the module.
 */
function linkTo(ctx: ConnectorContext, id: string): Record<string, string> {
  const module = moduleOf(ctx);
  return module === "Contacts" ? { Who_Id: id } : { What_Id: id, $se_module: module };
}

interface Token {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * What Zoho answers for a refresh token that will never work again: revoked by
 * their admin, or a client id or secret that is wrong. Its rate limit on new
 * tokens ("Access Denied") and outages pass, so those are retried instead.
 */
const GRANT_GONE = new Set(["invalid_code", "invalid_client", "invalid_client_secret"]);
class GrantGoneError extends Error {}

/** Zoho access tokens last an hour; the refresh token is the long-lived one we store. */
async function accessToken(ctx: ConnectorContext, fresh = false): Promise<string> {
  const cached = ctx.credentials.access_token;
  const until = Number(ctx.credentials.access_token_until ?? 0);
  if (!fresh && cached && until > Date.now() + 60_000) return cached;
  const dc = dcOf(ctx);
  const url = `${ACCOUNTS[dc] ?? ACCOUNTS.in}/oauth/v2/token`;
  await assertClientUrl(url);
  const body = new URLSearchParams({
    refresh_token: ctx.credentials.refresh_token ?? "",
    client_id: ctx.credentials.client_id ?? "",
    client_secret: ctx.credentials.client_secret ?? "",
    grant_type: "refresh_token",
  });
  const res = await ctx.fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, redirect: "error" });
  const j = (await res.json().catch(() => ({}))) as Token;
  if (!j.access_token) {
    const why = `Zoho refused the refresh token: ${j.error ?? res.status}`;
    throw GRANT_GONE.has(j.error ?? "") ? new GrantGoneError(`${why}. Reconnect Zoho.`) : new Error(why);
  }
  await ctx.save({ credentials: { ...ctx.credentials, access_token: j.access_token, access_token_until: String(Date.now() + (j.expires_in ?? 3600) * 1000) } });
  ctx.credentials.access_token = j.access_token;
  ctx.credentials.access_token_until = String(Date.now() + (j.expires_in ?? 3600) * 1000);
  return j.access_token;
}

async function call(ctx: ConnectorContext, path: string, init: RequestInit = {}, fresh = false): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const token = await accessToken(ctx, fresh);
  const url = `${API[dcOf(ctx)] ?? API.in}${path}`;
  await assertClientUrl(url);
  const res = await ctx.fetch(url, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    redirect: "error",
  });
  const text = (await res.text().catch(() => "")).slice(0, 4000);
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  // Zoho keeps only the newest 15 access tokens per refresh token and drops
  // the oldest, so a cached one can die before its hour is up. One more try
  // with a new token, before a 401 is taken as the connection's.
  if (res.status === 401 && json.code === "INVALID_TOKEN" && !fresh) return call(ctx, path, init, true);
  return { status: res.status, json, text };
}

/**
 * A refusal from Zoho, in the queue's terms. A 401 is our grant (a dead token,
 * a scope their admin did not give) and fails for every record alike. Anything
 * else is about this record.
 */
function refused(r: { status: number; text: string }, id?: string, progress?: Record<string, string>): SendResult {
  return { ok: false, httpStatus: r.status, response: r.text, retry: retryable(r.status), connectionBroken: r.status === 401, externalId: id, progress };
}

/** The id Zoho gave a record it just created, from {data: [{details: {id}}]}. */
const createdId = (r: { json: Record<string, unknown> }) => ((r.json.data as Array<{ details?: { id?: string } }> | undefined) ?? [])[0]?.details?.id;

/**
 * Their record for this person: the one we linked before, else a phone search.
 * A refused search is passed back as it is: read as "no match", a missing
 * search scope would put every caller on the not-in-Zoho list.
 */
async function findRecord(ctx: ConnectorContext, e: OutEvent): Promise<{ id: string | null } | { refused: SendResult }> {
  if (e.externalId) return { id: e.externalId };
  const phone = String((e.payload.person as Record<string, unknown> | undefined)?.phone ?? "");
  if (!phone) return { id: null };
  const r = await call(ctx, `/crm/v2/${moduleOf(ctx)}/search?phone=${encodeURIComponent(phone)}`);
  if (r.status >= 400) return { refused: refused(r) };
  const data = (r.json.data as Array<{ id?: string }> | undefined) ?? [];
  return { id: data[0]?.id ?? null };
}

interface Writeup {
  /** A finished call, logged as a Call record when Calls were granted. Everything else is a Note. */
  call: boolean;
  title: string;
  content: string;
}

/**
 * What each kind of event says on their record. A booked visit or an opt-out
 * is not a call: logged as one it read "Outcome: unknown", 00:00, Completed, a
 * call that never happened. A kind with nothing to say here gets no note.
 */
function writeup(e: OutEvent): Writeup | null {
  const p = e.payload;
  const said = (title: string, lines: string[], call = false): Writeup => ({
    call,
    title: title.slice(0, 120),
    content: [...lines.filter(Boolean), `Made by JENAI (AI call)`].join("\n").slice(0, 32_000),
  });
  if (e.kind === "call.completed") {
    const call = (p.call ?? {}) as Record<string, unknown>;
    const fields = (p.fields ?? {}) as Record<string, unknown>;
    const program = (p.program ?? {}) as Record<string, unknown>;
    return said(`JENAI call: ${String(program.name ?? "call")}`, [
      `Outcome: ${String(call.outcome ?? call.status ?? "unknown")}`,
      call.summary ? `Summary: ${String(call.summary)}` : "",
      Object.entries(fields).length ? `Answers: ${Object.entries(fields).map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`).join("; ")}` : "",
      call.seconds ? `Length: ${String(call.seconds)} seconds` : "",
      call.recording_url ? `Recording: ${String(call.recording_url)}` : "",
    ], true);
  }
  if (e.kind === "appointment.booked") {
    const appointment = (p.appointment ?? {}) as Record<string, unknown>;
    return said("JENAI: appointment booked", [`Booked on a call for: ${String(appointment.at ?? "a time to be confirmed")}`]);
  }
  if (e.kind === "do_not_call.added") {
    return said("JENAI: asked not to be called", [
      "Asked not to be called again. JENAI will not call this number.",
      p.source ? `Source: ${String(p.source)}` : "",
    ]);
  }
  return null;
}

export const zohoConnector: Connector = {
  kind: "zoho_crm",
  async test(ctx) {
    try {
      // Reading one record needs only the module read scope. Listing the
      // modules needs a settings scope most admins do not grant, and failing
      // the test on that would say "not connected" about a working connection.
      const r = await call(ctx, `/crm/v2/${moduleOf(ctx)}?per_page=1`);
      if (r.status === 200 || r.status === 204) {
        const writes = may(ctx, "ZohoCRM.modules.calls.CREATE")
          ? "logging each call as a Call record"
          : may(ctx, "ZohoCRM.modules.notes.CREATE")
            ? "adding a note after each call"
            : "updating fields only: no scope was granted to log the call itself";
        return { ok: true, message: `Connected to Zoho CRM (${dcOf(ctx)}). Reading ${moduleOf(ctx)}, ${writes}.` };
      }
      return { ok: false, message: `Zoho answered ${r.status}: ${r.text.slice(0, 160)}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message.slice(0, 200) };
    }
  },

  async send(ctx, e): Promise<SendResult> {
    // What earlier tries already wrote, plus what this one writes.
    const done: Record<string, string> = { ...(e.progress ?? {}) };
    try {
      const say = writeup(e);
      // Only the fields they mapped. Without a mapping applyMapping hands back
      // the whole event, and that is not something to PUT on their record.
      const mapping = ctx.integration.mapping?.fields;
      const fields = mapping && Object.keys(mapping).length ? applyMapping(e.payload, mapping) : {};
      // Skipped rather than done: nothing reached Zoho, so it says nothing about the connection.
      if (!say && !Object.keys(fields).length) return { ok: false, retry: false, response: `Nothing to write in Zoho for ${e.kind}` };

      const found = await findRecord(ctx, e);
      if ("refused" in found) return found.refused;
      const id = found.id;
      if (!id) {
        // Their CRM decides who exists. We do not create records unless asked to.
        if (!ctx.integration.config.createIfMissing) return { ok: false, response: "No matching record in Zoho for this number", retry: false };
        if (!may(ctx, `ZohoCRM.modules.${moduleOf(ctx).toLowerCase()}.CREATE`)) {
          return { ok: false, response: `No matching ${moduleOf(ctx)} record, and Zoho was not granted permission to create one`, retry: false };
        }
        const created = await call(ctx, `/crm/v2/${moduleOf(ctx)}`, {
          method: "POST",
          body: JSON.stringify({ data: [{ Last_Name: String((e.payload.person as Record<string, unknown>)?.name ?? "Unknown"), Phone: String((e.payload.person as Record<string, unknown>)?.phone ?? ""), Lead_Source: "JENAI call" }] }),
        });
        const newId = createdId(created);
        if (!newId) return refused(created);
        return this.send(ctx, { ...e, externalId: newId });
      }

      // How it gets recorded, in order of what the client granted. A Call
      // record is the better home for a call: it lands in their activity
      // history with a type, a time and a duration, rather than as loose text.
      // Written once: a retry after the field update failed finds it in done.
      let wrote = "nothing";
      let status = 200;
      const logged = done.Calls ?? done.Notes;
      if (say && logged) {
        wrote = `${done.Calls ? "call" : "note"} ${logged} already logged`;
      } else if (say?.call && may(ctx, "ZohoCRM.modules.calls.CREATE")) {
        const t = callTimes(e.payload);
        const direction = String(((e.payload.call ?? {}) as Record<string, unknown>).direction ?? "outbound");
        const r = await call(ctx, `/crm/v2/Calls`, {
          method: "POST",
          body: JSON.stringify({ data: [{
            Subject: say.title,
            Call_Type: direction === "inbound" ? "Inbound" : "Outbound",
            Call_Start_Time: t.start,
            Call_Duration: t.duration,
            Call_Status: "Completed",
            Description: say.content,
            ...linkTo(ctx, id),
          }] }),
        });
        if (r.status >= 400) return refused(r, id, done);
        // No id back would be odd, but the call is in Zoho all the same.
        done.Calls = createdId(r) ?? "logged";
        wrote = "call logged";
        status = r.status;
      } else if (say && may(ctx, "ZohoCRM.modules.notes.CREATE")) {
        const r = await call(ctx, `/crm/v2/Notes`, {
          method: "POST",
          body: JSON.stringify({ data: [{ Note_Title: say.title, Note_Content: say.content, Parent_Id: id, se_module: moduleOf(ctx) }] }),
        });
        if (r.status >= 400) return refused(r, id, done);
        done.Notes = createdId(r) ?? "logged";
        wrote = "note added";
        status = r.status;
      }

      // Fields the client chose to keep in step (for example Lead Status from the outcome).
      if (Object.keys(fields).length) {
        const upd = await call(ctx, `/crm/v2/${moduleOf(ctx)}/${id}`, { method: "PUT", body: JSON.stringify({ data: [fields] }) });
        if (upd.status >= 400) return refused(upd, id, done);
      }
      return { ok: true, httpStatus: status, externalId: id, progress: done, response: `${wrote} on ${moduleOf(ctx)} ${id}` };
    } catch (err) {
      const gone = err instanceof GrantGoneError;
      return { ok: false, response: (err as Error).message.slice(0, 300), retry: !gone, connectionBroken: gone, progress: done };
    }
  },
};
