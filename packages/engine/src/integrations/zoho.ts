import { assertClientUrl, toE164 } from "@jenai/voice";
import { zoned } from "../dialer/time";
import {
  CALL_DETAIL,
  HEALTH_DETAIL,
  applyMapping,
  retryable,
  type Connector,
  type ConnectorContext,
  type OutEvent,
  type PullInput,
  type PullResult,
  type PulledRecord,
  type SendResult,
} from "./types";

/**
 * Zoho CRM. The client keeps running Zoho exactly as they do today; JENAI adds
 * a note to the right record after every call, updates the fields they choose,
 * and can create a follow-up task. For the call plan it reads their Leads and
 * Contacts, keeping only the few fields planning uses (never their notes), and
 * writes nothing back for it.
 *
 * Setup on their side: a Self Client or server-based app in the Zoho API
 * console, scopes ZohoCRM.modules.ALL (or the narrower ones below),
 * ZohoSearch.securesearch.READ and ZohoCRM.settings.READ, and the refresh
 * token pasted into JENAI. Zoho's search needs the securesearch scope on top
 * of the module's read: without it no caller can be found by number. Data
 * centre matters: India accounts use .in, others .com, .eu, .com.au, .jp.
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

/**
 * Scopes Zoho has refused (OAUTH_SCOPE_MISMATCH) since this grant was made,
 * learned from its own answers. A grant's scopes are fixed until their admin
 * makes a new one, so asking again would only be refused again; reconnecting
 * clears the list.
 */
function denied(ctx: ConnectorContext): Set<string> {
  const raw = ctx.integration.config.denied;
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}

type Op = "READ" | "CREATE" | "UPDATE";
const scopeFor = (module: string, op: Op) => `ZohoCRM.modules.${module.toLowerCase()}.${op}`;

/** Zoho's v2 activities are Calls, Tasks and Events: a grant on them covers each. */
const ACTIVITIES = ["calls", "tasks", "events"];

/**
 * Whether their admin granted this operation on this module. A broader grant
 * covers it: every operation (ALL), or every write (WRITE, which Zoho's insert
 * and update pages both accept), on the module, on the activities a Call is
 * one of, or on every module (ZohoCRM.modules.READ reads them all).
 * Unknown scopes (Zoho did not say, or a token pasted in the form) means try,
 * unless Zoho has refused it since.
 */
const may = (ctx: ConnectorContext, module: string, op: Op) => {
  const m = module.toLowerCase();
  if (denied(ctx).has(scopeFor(m, op))) return false;
  const g = granted(ctx);
  if (!g.size) return true;
  const ops = op === "READ" ? ["READ", "ALL"] : [op, "WRITE", "ALL"];
  const on = [`ZohoCRM.modules.${m}`, "ZohoCRM.modules", ...(ACTIVITIES.includes(m) ? ["ZohoCRM.modules.activities"] : [])];
  return on.some((s) => ops.some((o) => g.has(`${s}.${o}`)));
};

/** Remembers a scope Zoho refused, so the events after this one do not ask for it again. */
async function deny(ctx: ConnectorContext, scope: string): Promise<void> {
  const d = denied(ctx);
  if (d.has(scope)) return;
  const list = [...d, scope];
  ctx.integration.config = { ...ctx.integration.config, denied: list };
  await ctx.save({ config: { denied: list } });
}

/**
 * The scopes a Zoho token answer lists, in the form may() compares
 * (ZohoCRM.modules.leads.CREATE). Zoho's samples separate them with spaces and
 * its prose says commas, so either is read. Case is evened out because their
 * admin types the scopes by hand in the API console. Null when Zoho did not
 * say, which is not the same as granting nothing.
 */
export function zohoScopes(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const scopes = raw.split(/[\s,]+/).filter(Boolean).map((s) => {
    const m = /^zohocrm\.(.+)\.([a-z]+)$/i.exec(s);
    return m ? `ZohoCRM.${m[1]!.toLowerCase()}.${m[2]!.toUpperCase()}` : s;
  });
  return [...new Set(scopes)];
}

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
function linkTo(module: string, id: string): Record<string, string> {
  return module === "Contacts" ? { Who_Id: id } : { What_Id: id, $se_module: module };
}

/**
 * Zoho keeps people in two modules, and both have a Phone and a Mobile field.
 * A Lead that is converted becomes a Contact, and a clinic's own patients
 * (the ones called back for a reminder or a recall) are usually Contacts.
 */
const PEOPLE = ["Leads", "Contacts"];

/**
 * Where to look for a caller, in order: the module set on the connection (the
 * one they chose), then Leads, then Contacts. Zoho's search leaves converted
 * Leads out, so a converted caller is only found in Contacts. Only modules
 * their admin let us read, as far as we know: one Zoho refuses anyway is left
 * out from then on, and the search goes on in the others.
 */
function lookIn(ctx: ConnectorContext): string[] {
  return [...new Set([moduleOf(ctx), ...PEOPLE])].filter((m) => may(ctx, m, "READ"));
}

/**
 * The module a record we already know is in, as remembered with its id. An id
 * their own system handed us does not say (its link reads "record"), and that
 * one is in the connection's module, as it always was.
 */
function moduleOfRecord(ctx: ConnectorContext, e: OutEvent): string {
  const t = e.externalType;
  return t && [moduleOf(ctx), ...PEOPLE].includes(t) ? t : moduleOf(ctx);
}

/**
 * The ways a front desk may have saved this number: with +91, or as the bare
 * ten digits. Zoho does not document how its phone search compares numbers,
 * so each form is asked for.
 */
function numberForms(phone: string): string[] {
  const e164 = toE164(phone) ?? phone;
  const local = /^\+91(\d{10})$/.exec(e164)?.[1];
  return local ? [e164, local] : [e164];
}

/**
 * The searches for one module, in the order they are tried. The phone search
 * looks at every phone field; the criteria search is an exact match on Mobile
 * or Phone, for a number the phone search does not read the way it was saved. Only Leads and
 * Contacts are known to have both fields. A number holds none of the
 * characters Zoho asks to be escaped in criteria, and the value is encoded.
 */
function searches(module: string, forms: string[]): string[] {
  const at = `/crm/v2/${module}/search`;
  return [
    ...forms.map((n) => `${at}?phone=${encodeURIComponent(n)}`),
    ...(PEOPLE.includes(module) ? forms.map((n) => `${at}?criteria=${encodeURIComponent(`((Mobile:equals:${n})or(Phone:equals:${n}))`)}`) : []),
  ];
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

/**
 * Refreshes under way, per connection. The pull and the write-backs share one
 * refresh token, and Zoho keeps only the newest 15 access tokens per refresh
 * token and limits how fast new ones are made, so callers that find the token
 * stale at the same moment wait for one refresh instead of each making their own.
 */
const refreshing = new Map<string, Promise<{ token: string; until: string }>>();

/** Zoho access tokens last an hour; the refresh token is the long-lived one we store. */
async function accessToken(ctx: ConnectorContext, fresh = false): Promise<string> {
  const cached = ctx.credentials.access_token;
  const until = Number(ctx.credentials.access_token_until ?? 0);
  if (!fresh && cached && until > Date.now() + 60_000) return cached;
  const key = `${ctx.integration.tenantId}:${ctx.integration.id}`;
  let flight = refreshing.get(key);
  if (!flight) {
    flight = refresh(ctx).finally(() => refreshing.delete(key));
    refreshing.set(key, flight);
  }
  const t = await flight;
  ctx.credentials.access_token = t.token;
  ctx.credentials.access_token_until = t.until;
  return t.token;
}

async function refresh(ctx: ConnectorContext): Promise<{ token: string; until: string }> {
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
  const until = String(Date.now() + (j.expires_in ?? 3600) * 1000);
  await ctx.save({ credentials: { ...ctx.credentials, access_token: j.access_token, access_token_until: until } });
  return { token: j.access_token, until };
}

interface Answer {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function call(ctx: ConnectorContext, path: string, init: RequestInit = {}, fresh = false): Promise<Answer> {
  const token = await accessToken(ctx, fresh);
  const url = `${API[dcOf(ctx)] ?? API.in}${path}`;
  await assertClientUrl(url);
  const res = await ctx.fetch(url, {
    ...init,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    redirect: "error",
  });
  // The whole body is read as JSON (a page of 200 records runs far past the
  // part kept as text for the delivery log).
  const body = await res.text().catch(() => "");
  const text = body.slice(0, 4000);
  let json: Record<string, unknown> = {};
  try {
    json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  // Zoho keeps only the newest 15 access tokens per refresh token and drops
  // the oldest, so a cached one can die before its hour is up. One more try
  // with a new token, before a 401 is taken as the connection's.
  if (res.status === 401 && json.code === "INVALID_TOKEN" && !fresh) return call(ctx, path, init, true);
  return { status: res.status, json, text };
}

/** A record of theirs and the module it is in. */
interface Found {
  id: string;
  module: string;
}

/**
 * What Zoho said about the one record a request was about. Its code sits at
 * the top of the answer or, for a write, in data[0], and a write's answer can
 * carry an error there under a 2xx status.
 */
function verdict(r: Answer): { code: string; message: string; field: string } {
  const row = ((r.json.data as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
  const details = (row.details ?? r.json.details ?? {}) as Record<string, unknown>;
  // A record write names the field in api_name; a search names its query parameter in param_name.
  return { code: String(row.code ?? r.json.code ?? ""), message: String(row.message ?? r.json.message ?? ""), field: String(details.api_name ?? details.param_name ?? "") };
}

/**
 * The id of the record a write made or changed, only when Zoho says it
 * succeeded. Anything else did not land, whatever the HTTP status, so it is
 * never counted as written and a retry writes it properly.
 */
function written(r: Answer): string | undefined {
  if (r.status >= 400) return undefined;
  const row = ((r.json.data as Array<{ status?: string; details?: { id?: string } }> | undefined) ?? [])[0];
  return row?.status === "success" ? row.details?.id : undefined;
}

/**
 * Refusals about what this connection may do, not about the record: a scope
 * the grant lacks (401 OAUTH_SCOPE_MISMATCH), or a right the profile of the
 * Zoho user who made the token lacks (403 NO_PERMISSION, 400
 * AUTHORIZATION_FAILED). Each is about one operation, so the others go on.
 */
const NOT_ALLOWED = new Set(["OAUTH_SCOPE_MISMATCH", "NO_PERMISSION", "AUTHORIZATION_FAILED"]);

/**
 * What a Zoho refusal means for us:
 *   later        an outage or a rate limit, worth trying again
 *   not-allowed  this connection may not do this one thing (see NOT_ALLOWED)
 *   connection   every record would get it: a dead token, a module they do not have
 *   gone         the record named is not there any more: converted, merged or
 *                deleted (Zoho calls the id invalid, on a Call's What_Id or
 *                Who_Id, a Note's Parent_Id, or the record a PUT names)
 *   record       about this record and what we sent
 */
function judge(r: Answer): "later" | "not-allowed" | "connection" | "gone" | "record" {
  const v = verdict(r);
  if (retryable(r.status)) return "later";
  if (NOT_ALLOWED.has(v.code)) return "not-allowed";
  if (r.status === 401 || v.code === "INVALID_MODULE") return "connection";
  if (v.code === "RECORD_NOT_FOUND") return "gone";
  if (v.code === "INVALID_DATA" && (["What_Id", "Who_Id", "Parent_Id", "id"].includes(v.field) || /\bid given seems to be invalid/i.test(v.message))) return "gone";
  return "record";
}

/** A refusal from Zoho, in the queue's terms. */
function refused(r: Answer, at?: Found, progress?: Record<string, string>): SendResult {
  const j = judge(r);
  const connection = j === "connection" || j === "not-allowed";
  return { ok: false, httpStatus: r.status, response: r.text, retry: j === "later", connectionBroken: connection, externalId: at?.id, externalType: at?.module, progress };
}

/**
 * Remembers a scope Zoho said the grant lacks. A profile's missing right is
 * not remembered: their admin can give it without a new grant.
 */
async function learn(ctx: ConnectorContext, r: Answer, scope: string): Promise<void> {
  if (verdict(r).code === "OAUTH_SCOPE_MISMATCH") await deny(ctx, scope);
}

/** Zoho's code for a refusal, or its status when it gave none, for the delivery log. */
const said = (r: Answer) => verdict(r).code || `HTTP ${r.status}`;

interface Looked {
  found: Found | null;
  /** Found through the id we remembered for this person, not by a search just now. */
  remembered: boolean;
  /** Where the number was searched, and where Zoho would not let us search. */
  looked: string[];
  unread: string[];
}

/**
 * Their record for this person: the one we linked before, else the first
 * match in lookIn's order. A module Zoho will not let us search is left for
 * the next, and only when no module can be searched is the connection
 * refused: a missing search scope would otherwise put every caller on the
 * not-in-Zoho list. Any other refused search is passed back as it is.
 */
async function findRecord(ctx: ConnectorContext, e: OutEvent): Promise<Looked | { refused: SendResult }> {
  if (e.externalId) return { found: { id: e.externalId, module: moduleOfRecord(ctx, e) }, remembered: true, looked: [], unread: [] };
  const phone = String((e.payload.person as Record<string, unknown> | undefined)?.phone ?? "");
  if (!phone) return { found: null, remembered: false, looked: [], unread: [] };
  const modules = lookIn(ctx);
  if (!modules.length) {
    const needed = [...new Set([moduleOf(ctx), ...PEOPLE])].map((m) => scopeFor(m, "READ")).join(" or ");
    return { refused: { ok: false, retry: false, connectionBroken: true, response: `Zoho was not granted ${needed}, so no caller can be found` } };
  }
  const looked: string[] = [];
  const unread: Array<{ module: string; r: Answer }> = [];
  // Only a refusal another module's search did not get is about the module.
  // When every search is refused, it is the search itself
  // (ZohoSearch.securesearch.READ), and remembering each module as unreadable
  // would say the wrong thing.
  const learnUnread = async () => {
    for (const u of unread) await learn(ctx, u.r, scopeFor(u.module, "READ"));
  };
  next: for (const module of modules) {
    for (const path of searches(module, numberForms(phone))) {
      const r = await call(ctx, path);
      if (r.status >= 400) {
        if (judge(r) !== "not-allowed") return { refused: refused(r) };
        unread.push({ module, r });
        continue next;
      }
      const id = ((r.json.data as Array<{ id?: string }> | undefined) ?? [])[0]?.id;
      if (id) {
        await learnUnread();
        return { found: { id, module }, remembered: false, looked: [...looked, module], unread: unread.map((u) => `${u.module} (${said(u.r)})`) };
      }
    }
    looked.push(module);
  }
  if (!looked.length) {
    const last = unread.at(-1)!.r;
    return {
      refused: {
        ok: false,
        retry: false,
        connectionBroken: true,
        httpStatus: last.status,
        response: `Zoho refused the search in ${unread.map((u) => `${u.module} (${said(u.r)})`).join(" and ")}, so no caller can be found. Searching needs ZohoSearch.securesearch.READ and the module's READ scope. ${last.text}`.slice(0, 1000),
      },
    };
  }
  await learnUnread();
  return { found: null, remembered: false, looked, unread: unread.map((u) => `${u.module} (${said(u.r)})`) };
}

/**
 * The record this event goes on: found, or made when the client asked for
 * callers who are not in Zoho to be added. A result instead when there is
 * none to write on.
 */
async function resolve(ctx: ConnectorContext, e: OutEvent): Promise<{ at: Found; remembered: boolean } | { result: SendResult }> {
  const looked = await findRecord(ctx, e);
  if ("refused" in looked) return { result: looked.refused };
  if (looked.found) return { at: looked.found, remembered: looked.remembered };
  if (!looked.looked.length) return { result: { ok: false, retry: false, response: "No phone number to find this person by in Zoho" } };
  const where = `looked in ${looked.looked.join(" and ")}${looked.unread.length ? `; Zoho would not let us search ${looked.unread.join(" or ")}` : ""}`;
  // Their CRM decides who exists. We do not create records unless asked to.
  if (!ctx.integration.config.createIfMissing) return { result: { ok: false, retry: false, response: `No matching record in Zoho for this number (${where})` } };
  const module = moduleOf(ctx);
  if (!may(ctx, module, "CREATE")) {
    return { result: { ok: false, retry: false, response: `No matching record in ${looked.looked.join(" or ")}, and Zoho was not granted permission to create one in ${module}` } };
  }
  const person = (e.payload.person ?? {}) as Record<string, unknown>;
  const created = await call(ctx, `/crm/v2/${module}`, {
    method: "POST",
    body: JSON.stringify({ data: [{ Last_Name: String(person.name ?? "Unknown"), Phone: String(person.phone ?? ""), Lead_Source: "JENAI call" }] }),
  });
  const id = written(created);
  if (id) return { at: { id, module }, remembered: false };
  if (judge(created) === "not-allowed") {
    await learn(ctx, created, scopeFor(module, "CREATE"));
    return { result: { ok: false, retry: false, httpStatus: created.status, response: `No matching record in ${looked.looked.join(" or ")}, and Zoho refused to create one in ${module} (${said(created)})` } };
  }
  return { result: refused(created) };
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
 * That includes lead.updated: a stage or follow-up date reaches their record
 * only through the fields they mapped (lead.stage), and with no mapping
 * nothing is written for it.
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
    const appointment = (p.appointment ?? {}) as Record<string, unknown>;
    // What the front desk needs before calling back: which try this was, what
    // they asked about, how keen they were, and where the call left things.
    const line = (label: string, v: unknown) => (v === null || v === undefined || v === "" ? "" : `${label}: ${String(v)}`);
    return said(`JENAI call: ${String(program.name ?? "call")}`, [
      `Outcome: ${String(call.outcome ?? call.status ?? "unknown")}`,
      line("Attempt", call.attempt),
      line("About", call.concern),
      line("Interest", call.interest_level),
      line("Next step", call.next_step),
      appointment.at ? `Agreed time: ${String(appointment.at)}${appointment.booked ? " (booked)" : ""}` : "",
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

/** The kinds writeup() has something to say for. Any other reaches Zoho only through mapped fields. */
const WRITTEN_UP = ["call.completed", "appointment.booked", "do_not_call.added"];

/**
 * Writes one event on one record, in order of what the client granted. A
 * Call record is the better home for a call: it lands in their activity
 * history with a type, a time and a duration, rather than as loose text.
 * Whatever already landed (done) is not written again.
 *
 * "gone" when Zoho says the record is not there, for send() to look again.
 */
async function writeOn(ctx: ConnectorContext, e: OutEvent, say: Writeup | null, mapped: Record<string, unknown>, at: Found, done: Record<string, string>): Promise<SendResult | { gone: Answer }> {
  const { id, module } = at;
  // What was left out and why, for the delivery log, and the last refusal from Zoho behind it.
  const left: string[] = [];
  let refusal: Answer | undefined;
  // Mapped fields only with the update scope on the module the record is in.
  const fields = may(ctx, module, "UPDATE") ? mapped : {};
  if (Object.keys(mapped).length && !Object.keys(fields).length) left.push(`mapped fields left alone, Zoho was not granted ${scopeFor(module, "UPDATE")}`);
  if (!say && !Object.keys(fields).length) return { ok: false, retry: false, externalId: id, externalType: module, progress: done, response: [`Nothing to write in Zoho for ${e.kind}`, ...left].join("; ") };

  let wrote = "";
  let status = 200;
  const logged = done.Calls ?? done.Notes;
  if (say && logged) {
    wrote = `${done.Calls ? "call" : "note"} ${logged} already logged`;
  } else if (say) {
    let asNote = !say.call;
    if (say.call && !may(ctx, "calls", "CREATE")) {
      asNote = true;
      left.push(`not logged as a Call, Zoho was not granted ${scopeFor("calls", "CREATE")}`);
    } else if (say.call) {
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
          ...linkTo(module, id),
        }] }),
      });
      const callId = written(r);
      const j = callId ? null : judge(r);
      if (callId) {
        done.Calls = callId;
        wrote = "call logged";
        status = r.status;
      } else if (j === "later" || j === "connection") {
        return refused(r, at, done);
      } else if (j === "gone") {
        return { gone: r };
      } else {
        // Their Calls will not take it: a scope or a right not given, a field
        // their layout makes mandatory, a value it reads differently. That is
        // true of every call, so the same words go in a Note instead.
        await learn(ctx, r, scopeFor("calls", "CREATE"));
        left.push(`not logged as a Call, Zoho answered ${said(r)}`);
        refusal = r;
        asNote = true;
      }
    }
    if (asNote && !may(ctx, "notes", "CREATE")) {
      left.push(`no note, Zoho was not granted ${scopeFor("notes", "CREATE")}`);
    } else if (asNote) {
      const r = await call(ctx, `/crm/v2/Notes`, {
        method: "POST",
        body: JSON.stringify({ data: [{ Note_Title: say.title, Note_Content: say.content, Parent_Id: id, se_module: module }] }),
      });
      const noteId = written(r);
      const j = noteId ? null : judge(r);
      if (noteId) {
        done.Notes = noteId;
        wrote = "note added";
        status = r.status;
      } else if (j === "gone") {
        return { gone: r };
      } else if (j === "not-allowed") {
        await learn(ctx, r, scopeFor("notes", "CREATE"));
        left.push(`no note, Zoho answered ${said(r)}`);
        refusal = r;
      } else {
        return refused(r, at, done);
      }
    }
  }

  // Fields the client chose to keep in step (for example Lead Status from the outcome).
  if (Object.keys(fields).length) {
    const upd = await call(ctx, `/crm/v2/${module}/${id}`, { method: "PUT", body: JSON.stringify({ data: [fields] }) });
    const j = written(upd) ? null : judge(upd);
    if (!j) {
      if (!wrote) {
        wrote = "fields updated";
        status = upd.status;
      }
    } else if (j === "gone") {
      return { gone: upd };
    } else if (j === "not-allowed") {
      await learn(ctx, upd, scopeFor(module, "UPDATE"));
      left.push(`mapped fields left alone, Zoho answered ${said(upd)}`);
      refusal = upd;
    } else {
      return refused(upd, at, done);
    }
  }

  // Nothing reached their record. Skipped with the reason rather than done,
  // or the log would show as handed on an opt-out Zoho never got.
  if (!wrote) return { ok: false, retry: false, httpStatus: refusal?.status, externalId: id, externalType: module, progress: done, response: `Nothing written on ${module} ${id} for ${e.kind}: ${left.join("; ")}` };
  return { ok: true, httpStatus: status, externalId: id, externalType: module, progress: done, response: [`${wrote} on ${module} ${id}`, ...left].join("; ") };
}

/**
 * What this connection will write, from what their admin granted, for the
 * Test button. What was not granted is said as plainly as what was: a client
 * expecting Lead Status to change after each call hears here that it will not.
 */
function writes(ctx: ConnectorContext): string {
  if (!granted(ctx).size) {
    const no = [...denied(ctx)];
    return `Zoho did not say which scopes it granted, so each write is tried, and one Zoho refuses is left out from then on${no.length ? ` (refused so far: ${no.join(", ")})` : ""}.`;
  }
  const module = moduleOf(ctx);
  const calls = may(ctx, "calls", "CREATE");
  const notes = may(ctx, "notes", "CREATE");
  const yes: string[] = [];
  const no: string[] = [];
  if (calls) yes.push("each call as a Call record");
  if (notes) yes.push(calls ? "a note for each booking and opt-out" : "a note for each call, booking and opt-out");
  else no.push(calls ? "notes for bookings and opt-outs" : "anything about calls, bookings or opt-outs");
  if (Object.keys(ctx.integration.mapping?.fields ?? {}).length) {
    // Written on whichever module the caller was found in.
    const can = lookIn(ctx).filter((m) => may(ctx, m, "UPDATE"));
    const cannot = lookIn(ctx).filter((m) => !may(ctx, m, "UPDATE"));
    if (can.length) yes.push(`the mapped fields on ${can.join(" and ")} records`);
    if (cannot.length) no.push(`the mapped fields on ${cannot.join(" and ")} records`);
  }
  if (ctx.integration.config.createIfMissing) (may(ctx, module, "CREATE") ? yes : no).push(`a new ${module} record for a caller not in Zoho`);
  return [yes.length ? `Writing ${yes.join(", ")}.` : "", no.length ? `Not granted, so not written: ${no.join(", ")}.` : ""].filter(Boolean).join(" ");
}

/** How the Test button names what a call says outside its answers. */
const DETAIL_NAMES: Record<string, string> = { summary: "the summary", concern: "what it was about", recording: "the recording link", outcome: "an outcome its program does not mark shareable" };

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/**
 * What of each call reaches Zoho, for the Test button: the rules sharedWith
 * applied before the event was queued, so a field mapped to something left
 * out stays empty.
 */
function shares(ctx: ConnectorContext): string {
  const raw = ctx.integration.config.share;
  const list = Array.isArray(raw) ? raw.map(String) : null;
  const kept = Object.keys(CALL_DETAIL).filter((k) => !list?.includes(k)).map((k) => DETAIL_NAMES[k]!);
  const health = kept.length ? ` On a health call, ${listed(kept)} stay in JENAI.` : "";
  if (list) {
    const answers = list.filter((k) => !(k in CALL_DETAIL));
    return `Answers from calls handed on: ${answers.length ? answers.join(", ").replace(/_/g, " ") : "none"}.${health}`;
  }
  return `Health answers (${HEALTH_DETAIL.join(", ").replace(/_/g, " ")}) stay in JENAI, and so does any answer a health program does not mark shareable.${health}`;
}

/** A number nobody has, for the Test button's search: Zoho answers it with nothing found when searching is allowed. */
const PROBE = "0000000000";

// ---------------------------------------------------------------- reading their records, for the call plan

const PULL_KEYS = [
  "phone",
  "fullName",
  "firstName",
  "lastName",
  "status",
  "source",
  "notes",
  "appointment",
  "followUp",
  "treatment",
  "subTreatment",
  "category",
  "consultant",
  "centre",
] as const;
type PullKey = (typeof PULL_KEYS)[number];

/**
 * Where each thing the call plan reads usually sits in a clinic's Zoho, by the
 * label their admin gave the field. Labels differ from one Zoho to the next,
 * so each is a list tried in order, and a client's own list
 * (config.pull.fieldLabels.<item>) replaces the default for that item. A label
 * also matches a field's API name, case, spaces and punctuation aside.
 */
export const ZOHO_PULL_LABELS: Record<PullKey, string[]> = {
  phone: ["Mobile", "Phone"],
  fullName: ["Full Name"],
  firstName: ["First Name"],
  lastName: ["Last Name"],
  status: ["Lead Status"],
  source: ["Lead Source"],
  notes: ["Description"],
  appointment: ["Appointment Date/Time", "Appointment Date", "Appointment"],
  followUp: ["Follow Up Date/Time", "Follow-up Date", "Callback Date"],
  treatment: ["Treatment", "Service"],
  subTreatment: ["Sub Category", "Sub Treatment"],
  category: ["Category"],
  consultant: ["Consultant Name", "Doctor"],
  centre: ["Select Your Centre", "Select Your Branch", "Centre", "Branch", "Location"],
};

/** Records per page: Zoho's most (get-records: per_page "default and maximum is 200"). */
const PER_PAGE = 200;
/**
 * The deepest page asked for. Zoho's later API versions stop page-based
 * listing at 2,000 records; v2's page does not say, so we stop there too and
 * start again from the newest change read instead.
 */
const MAX_PAGE = 10;
const READ_TIMEOUT_MS = 30_000;
const FIELDS_SCOPE = "ZohoCRM.settings.fields.READ";
/** How long a module's field list is trusted before it is read again. */
const FIELD_MAP_MS = 60 * 60_000;

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function labelsOf(ctx: ConnectorContext): Record<PullKey, string[]> {
  const pull = (ctx.integration.config.pull ?? {}) as Record<string, unknown>;
  const theirs = (pull.fieldLabels ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    PULL_KEYS.map((k) => {
      const own = theirs[k];
      return [k, Array.isArray(own) && own.length ? own.map(String) : ZOHO_PULL_LABELS[k]];
    }),
  ) as Record<PullKey, string[]>;
}

/** The fields of theirs, by API name, that each label list points at, in the order of the labels. */
function namesFor(labels: Record<PullKey, string[]>, fields: Array<{ api: string; labels: string[] }>): Record<PullKey, string[]> {
  const out = {} as Record<PullKey, string[]>;
  for (const k of PULL_KEYS) {
    out[k] = [];
    for (const label of labels[k]) {
      const want = squash(label);
      if (!want) continue;
      for (const f of fields) if (!out[k].includes(f.api) && f.labels.some((l) => squash(l) === want)) out[k].push(f.api);
    }
  }
  return out;
}

interface FieldMap {
  /** API names per item. Null when their field list could not be read: then each record's own keys are matched. */
  names: Record<PullKey, string[]> | null;
  /** The fields to ask for. Empty asks for every field. */
  ask: string[];
  note?: string;
}

const fieldMaps = new Map<string, { at: number; map: FieldMap }>();

/** Whether their admin granted reading the field list. Unknown scopes mean try, unless Zoho refused it since. */
function mayReadFields(ctx: ConnectorContext): boolean {
  if (denied(ctx).has(FIELDS_SCOPE)) return false;
  const g = granted(ctx);
  return !g.size || [FIELDS_SCOPE, "ZohoCRM.settings.fields.ALL", "ZohoCRM.settings.READ", "ZohoCRM.settings.ALL"].some((s) => g.has(s));
}

/**
 * Which of their fields hold what the plan reads, from Zoho's own field list
 * (settings/fields), kept for an hour per connection. Without the settings
 * scope every field is asked for and matched by its API name instead, which
 * finds the standard fields and most custom ones.
 */
async function fieldMap(ctx: ConnectorContext, module: string): Promise<FieldMap | { refused: Answer }> {
  const labels = labelsOf(ctx);
  const fallback = (why: string): FieldMap => ({ names: null, ask: [], note: `${why}, so ${module} fields were matched by their API names.` });
  if (!mayReadFields(ctx)) return fallback(`Zoho was not granted ${FIELDS_SCOPE}`);
  const key = `${ctx.integration.tenantId}:${ctx.integration.id}:${dcOf(ctx)}:${module}:${JSON.stringify(labels)}`;
  const hit = fieldMaps.get(key);
  if (hit && Date.now() - hit.at < FIELD_MAP_MS) return hit.map;
  const r = await call(ctx, `/crm/v2/settings/fields?module=${encodeURIComponent(module)}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (r.status !== 200) {
    if (judge(r) !== "not-allowed") return { refused: r };
    await learn(ctx, r, FIELDS_SCOPE);
    return fallback(`Zoho would not list the fields (${said(r)})`);
  }
  const fields = ((r.json.fields as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((f) => typeof f.api_name === "string")
    .map((f) => ({ api: String(f.api_name), labels: [f.field_label, f.display_label, f.api_name].filter((x): x is string => typeof x === "string") }));
  const names = namesFor(labels, fields);
  // Modified_Time orders the read and moves the cursor, so it is always asked for.
  const map: FieldMap = { names, ask: [...new Set(["Modified_Time", "Created_Time", ...PULL_KEYS.flatMap((k) => names[k])])] };
  fieldMaps.set(key, { at: Date.now(), map });
  return map;
}

/** A field's value as plain text: a pick list, a lookup ({name}), a multi-select, a number. */
function textOf(v: unknown, max = 200): string | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (Array.isArray(v)) return textOf(v.map((x) => textOf(x, max)).filter(Boolean).join(", "), max);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return textOf(o.name ?? o.display_value ?? null, max);
  }
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

const instant = (v: unknown): Date | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Zoho's If-Modified-Since takes ISO 8601 with an offset ("2019-07-25T15:26:49+05:30"). */
const zohoTime = (d: Date) => `${d.toISOString().slice(0, 19)}+00:00`;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A day written the Indian way, day first: 3/10/26, 5-10-2026, 12/10,
 * "3 /10/ 26", 5.10.2026, 5th Oct, 5 October 2026. A dot needs the year, so
 * a time such as 10.30 is never read as a day, and neither is a span of
 * hours or days ("5-6 pm", "2-3 days").
 */
const NOT_A_SPAN = String.raw`(?!\d)(?!\s*(?:am|pm|a\.m|p\.m|o'?clock|hrs?|hours?|mins?|minutes?|days?|weeks?|wks?|months?|years?|yrs?)\b)`;
const DAY_FIRST = [
  String.raw`(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{4}|\d{2}))?${NOT_A_SPAN}`,
  String.raw`(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4}|\d{2})${NOT_A_SPAN}`,
  String.raw`(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?\b`,
].join("|");

/**
 * Words that say a callback is meant, then the few words that may stand
 * between them and the day ("call back after", "cb", "call her on",
 * "follow up by"). Anything else in between ("call received on 2/9") is not a
 * callback, and its date is left alone.
 */
const CUE = String.raw`\b(?:call(?:ing)?[\s-]*back|callback|cb|call|ring|follow[\s-]*up|f\/u|remind(?:er)?)\b`;
const FILLER = String.raw`(?:[\s:,.@-]*\b(?:after|on|by|before|from|for|the|again|date|dt|is|at|next|this|me|him|her|them|pt|patient|client)\b)*[\s:,.@-]*`;
const CALLBACK = new RegExp(`${CUE}${FILLER}(?:${DAY_FIRST})`, "gi");
const A_DAY = new RegExp(`(?<![\\d./-])(?:${DAY_FIRST})`, "i");

/**
 * The day a match names. Without a year (or with one that cannot be meant),
 * the year that puts it nearest the record's own time is taken, so a note
 * "call on 5/1" written in late December reads as January next year.
 */
function dayOf(g: Array<string | undefined>, ref: Date, tz: string): Date | null {
  const [d, m, y] = g[0] ? [g[0], g[1], g[2]] : g[3] ? [g[3], g[4], g[5]] : [g[6], String(MONTHS.indexOf(String(g[7]).toLowerCase().slice(0, 3)) + 1), g[8]];
  const day = Number(d);
  const month = Number(m);
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  const refYear = ref.getUTCFullYear();
  let year = y ? Number(y.length === 2 ? `20${y}` : y) : null;
  if (year !== null && (year < refYear - 1 || year > refYear + 2)) year = null;
  const real = (yy: number) => {
    const t = new Date(Date.UTC(yy, month - 1, day));
    return t.getUTCMonth() === month - 1 ? zoned(yy, month, day, 0, tz) : null;
  };
  if (year !== null) return real(year);
  const near = [refYear - 1, refYear, refYear + 1].map(real).filter((x): x is Date => x !== null);
  return near.sort((a, b) => Math.abs(a.getTime() - ref.getTime()) - Math.abs(b.getTime() - ref.getTime()))[0] ?? null;
}

/**
 * A callback date the team wrote in a record's notes ("call back after 3 /10/
 * 26", "cb 5-10-2026", "call on 12/10"), as the start of that day in the
 * client's time zone. The latest one, when the notes name several, since a
 * callback is pushed forward more often than back. Null for anything else.
 * Only the date leaves here: the notes themselves are never kept or logged.
 */
export function callbackFromNotes(notes: string | null | undefined, ref: Date, tz = "Asia/Kolkata"): Date | null {
  if (!notes) return null;
  let latest: Date | null = null;
  for (const m of notes.matchAll(CALLBACK)) {
    const day = dayOf(m.slice(1), ref, tz);
    if (day && (!latest || day > latest)) latest = day;
  }
  return latest;
}

/**
 * A date or time field's value: Zoho's datetime ("2026-10-05T11:00:00+05:30"),
 * its date ("2026-10-05", the start of that day for the client), or a day
 * typed into a text field, read day first.
 */
function whenOf(v: unknown, ref: Date, tz: string): Date | null {
  const s = textOf(v);
  if (!s) return null;
  // Year first is ISO: Zoho's own date and datetime, or a date typed that way.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(T)?/.exec(s);
  if (iso) {
    const at = iso[4] ? instant(s) : null;
    if (at) return at;
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const day = new Date(Date.UTC(y, m - 1, d));
    return day.getUTCMonth() === m - 1 && day.getUTCDate() === d ? zoned(y, m, d, 0, tz) : null;
  }
  const m = A_DAY.exec(s);
  return m ? dayOf(m.slice(1), ref, tz) : null;
}

/** One Zoho record as the plan reads it. Nothing else of it, the notes least of all, goes further. */
function readRecord(raw: Record<string, unknown>, module: string, map: FieldMap, labels: Record<PullKey, string[]>, tz: string): PulledRecord | null {
  const externalId = textOf(raw.id, 64);
  if (!externalId) return null;
  const names = map.names ?? namesFor(labels, Object.keys(raw).map((k) => ({ api: k, labels: [k] })));
  const values = (k: PullKey) => names[k].map((n) => raw[n]);
  const first = (k: PullKey, max?: number) => values(k).map((v) => textOf(v, max)).find(Boolean) ?? null;
  const modifiedAt = instant(raw.Modified_Time);
  const createdAt = instant(raw.Created_Time);
  const ref = modifiedAt ?? createdAt ?? new Date();
  const when = (k: PullKey) => values(k).map((v) => whenOf(v, ref, tz)).find(Boolean) ?? null;
  // Mobile first: it is the number the person answers.
  const phone = values("phone").map((v) => toE164(textOf(v, 40))).find(Boolean) ?? null;
  const name = first("fullName") ?? ([first("firstName"), first("lastName")].filter(Boolean).join(" ") || null);
  // A Lead Zoho itself converted is a Contact now, whatever its status said when it was.
  const status = raw.$converted === true ? "Converted" : first("status");
  const parts = [first("treatment"), first("subTreatment"), first("category")].filter((x): x is string => !!x);
  const treatment = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i).join(" / ").slice(0, 300) || null;
  return {
    externalId,
    module,
    modifiedAt,
    createdAt,
    phone,
    name,
    status,
    source: first("source"),
    centre: first("centre"),
    appointmentAt: when("appointment"),
    followUpAt: when("followUp") ?? callbackFromNotes(first("notes", 32_000), ref, tz),
    treatment,
    consultant: first("consultant"),
  };
}

/** Where one module got to: the newest change stored, and a page only while stuck on one second (see pullZoho). */
interface ModuleCursor {
  since?: string;
  page?: number;
  deleted?: { since?: string; page?: number; newest?: string };
}

function cursorOf(raw: Record<string, unknown>): ModuleCursor {
  const str = (v: unknown) => (typeof v === "string" && instant(v) ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 1 && v <= MAX_PAGE ? v : undefined);
  const d = (raw.deleted ?? {}) as Record<string, unknown>;
  return { since: str(raw.since), page: num(raw.page), deleted: { since: str(d.since), page: num(d.page), newest: str(d.newest) } };
}

const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * What changed in one module since the cursor, oldest change first, and what
 * was deleted there. Read only.
 *
 * Changes are listed by Modified_Time with If-Modified-Since one second before
 * the newest change already stored, so records sharing that second are read
 * again rather than lost; storing them twice changes nothing. The cursor moves
 * only as far as what this read hands back, and the caller stores it after
 * the records. Page-based listing stops at page 10, so a longer backlog is
 * read again from its newest change, on this run if the budget allows or the
 * next.
 *
 * Deletions are read once the changes are caught up. On the first read they
 * start from now: a record deleted before we ever read it was never listed.
 */
async function pullZoho(ctx: ConnectorContext, input: PullInput): Promise<PullResult> {
  const { module } = input;
  const tz = input.timeZone ?? "Asia/Kolkata";
  const cur = cursorOf(input.cursor);
  const out: PullResult = { records: [], deleted: [], cursor: input.cursor, done: false, pages: 0 };
  const notes: string[] = [];
  if (!may(ctx, module, "READ")) return { ...out, done: true, skipped: `${module} not read: Zoho was not granted ${scopeFor(module, "READ")}.` };
  let budget = Math.max(0, Math.floor(input.pageBudget));
  const signal = () => AbortSignal.timeout(READ_TIMEOUT_MS);

  // Changes. `from` is the time the listing reads from, `newest` the newest change read so far.
  let from = cur.since ? new Date(cur.since) : null;
  let page = cur.page ?? 1;
  let newest: Date | null = from;
  let more = true;
  let stopped = false;
  // Zoho lists no deeper than MAX_PAGE, so the listing starts again from the newest change read.
  const restart = () => {
    if (newest && (!from || newest > from)) from = newest;
    else {
      // A whole listing changed within one second (a mass update): the rest
      // of that second is passed over and read the next time it changes.
      const at = newest ?? from;
      from = at ? new Date(at.getTime() + 2000) : null;
      notes.push(`More than ${MAX_PAGE * PER_PAGE} ${module} changed within one second; Zoho lists no further, so the rest are read when they next change.`);
    }
    page = 1;
  };
  // Deletions are counted from the first read on.
  const deletedSince = cur.deleted?.since ? new Date(cur.deleted.since) : new Date(Date.now() - 10 * 60_000);
  let deleted: ModuleCursor["deleted"] = { ...cur.deleted, since: deletedSince.toISOString() };

  const stop = (r: Answer, what: string) => {
    stopped = true;
    if (verdict(r).code === "INVALID_MODULE") out.skipped = `${module} not read: Zoho has no module by that name.`;
    else if (judge(r) === "not-allowed") out.skipped = `${module} not read: Zoho answered ${said(r)} to ${what}. The grant needs ${scopeFor(module, "READ")}.`;
    else out.error = `Zoho answered ${said(r)} to ${what} in ${module}.`;
  };

  try {
    const map = await fieldMap(ctx, module);
    if ("refused" in map) {
      stop(map.refused, "the list of fields");
      return { ...out, done: !!out.skipped, notes };
    }
    if (map.note) notes.push(map.note);
    const labels = labelsOf(ctx);

    while (more && budget > 0) {
      if (page > MAX_PAGE) restart();
      const q = new URLSearchParams({ sort_by: "Modified_Time", sort_order: "asc", per_page: String(PER_PAGE), page: String(page) });
      if (map.ask.length) q.set("fields", map.ask.join(","));
      // Zoho leaves converted Leads out unless asked, and they are the ones not to chase.
      if (module === "Leads") q.set("converted", "both");
      const headers: Record<string, string> = from ? { "If-Modified-Since": zohoTime(new Date(from.getTime() - 1000)) } : {};
      const r = await call(ctx, `/crm/v2/${encodeURIComponent(module)}?${q}`, { headers, signal: signal() });
      budget--;
      out.pages++;
      if (r.status === 204 || r.status === 304) {
        more = false;
        break;
      }
      if (r.status !== 200) {
        if (judge(r) === "not-allowed") await learn(ctx, r, scopeFor(module, "READ"));
        stop(r, "a request for records");
        break;
      }
      for (const raw of (r.json.data as Array<Record<string, unknown>> | undefined) ?? []) {
        const rec = readRecord(raw, module, map, labels, tz);
        if (!rec) continue;
        out.records.push(rec);
        newest = later(newest, rec.modifiedAt);
      }
      more = (r.json.info as { more_records?: boolean } | undefined)?.more_records === true;
      if (more) page++;
    }
  } catch (e) {
    stopped = true;
    out.error = `Reading ${module} stopped: ${(e as Error).message}`.slice(0, 300);
  }

  // Where the next read starts: from the newest change read, or, while one
  // second's changes run deeper than a page, the next page of that listing.
  if (more && page > MAX_PAGE) restart();
  const next: ModuleCursor =
    !more || (newest && (!from || newest > from)) ? { since: later(newest, from)?.toISOString() } : { since: from?.toISOString(), page: page > 1 ? page : undefined };

  // Deletions, once the changes are caught up.
  let deletionsDone = false;
  if (!more && !stopped) {
    let dPage = cur.deleted?.page ?? 1;
    let dNewest: Date | null = cur.deleted?.newest ? new Date(cur.deleted.newest) : deletedSince;
    let dMore = true;
    try {
      while (dMore && budget > 0 && dPage <= MAX_PAGE) {
        const r = await call(ctx, `/crm/v2/${encodeURIComponent(module)}/deleted?type=all&per_page=${PER_PAGE}&page=${dPage}`, {
          headers: { "If-Modified-Since": zohoTime(new Date(deletedSince.getTime() - 1000)) },
          signal: signal(),
        });
        budget--;
        out.pages++;
        if (r.status === 204 || r.status === 304) {
          dMore = false;
          break;
        }
        if (r.status !== 200) {
          if (judge(r) === "not-allowed") {
            // Not worth stopping the plan for: the records read stay good.
            notes.push(`Deleted ${module} not read: Zoho answered ${said(r)}.`);
            dMore = false;
            dNewest = deletedSince;
          } else out.error = `Zoho answered ${said(r)} to the list of deleted ${module}.`;
          break;
        }
        for (const x of (r.json.data as Array<Record<string, unknown>> | undefined) ?? []) {
          const id = textOf(x.id, 64);
          const at = instant(x.deleted_time);
          if (!id || !at) continue;
          out.deleted.push({ externalId: id, deletedAt: at });
          dNewest = later(dNewest, at);
        }
        dMore = (r.json.info as { more_records?: boolean } | undefined)?.more_records === true;
        if (dMore) dPage++;
      }
    } catch (e) {
      out.error = `Reading deleted ${module} stopped: ${(e as Error).message}`.slice(0, 300);
    }
    if (!dMore || dPage > MAX_PAGE) {
      deleted = { since: (dNewest ?? deletedSince).toISOString() };
      deletionsDone = !dMore;
      if (dMore) notes.push(`More than ${MAX_PAGE * PER_PAGE} ${module} were deleted since the last read; Zoho lists no further, so some of them may still show here as not deleted.`);
    } else deleted = { since: deletedSince.toISOString(), page: dPage, newest: dNewest?.toISOString() };
  }

  // A module skipped for good (a scope, a name) has nothing more to read until someone changes that.
  return { ...out, cursor: { ...next, deleted }, done: !!out.skipped || (!more && deletionsDone && !out.error), notes };
}

export const zohoConnector: Connector = {
  kind: "zoho_crm",
  pullModules: PEOPLE,
  pull: pullZoho,

  wants(integration, kind) {
    // A kind with nothing to say on a record reaches Zoho only through the
    // fields they mapped: queued without a mapping, it could only be skipped.
    return WRITTEN_UP.includes(kind) || Object.keys(integration.mapping?.fields ?? {}).length > 0;
  },

  async test(ctx) {
    try {
      // Reading one record needs only the module read scope. Listing the
      // modules needs a settings scope most admins do not grant, and failing
      // the test on that would say "not connected" about a working connection.
      const r = await call(ctx, `/crm/v2/${moduleOf(ctx)}?per_page=1`);
      if (r.status !== 200 && r.status !== 204) return { ok: false, message: `Zoho answered ${r.status}: ${r.text.slice(0, 160)}` };
      // Reading a record does not prove a caller can be found: Zoho's search
      // also needs ZohoSearch.securesearch.READ. Asked here, a missing scope
      // fails the Test instead of the first delivery for a caller not yet linked.
      const where: string[] = [];
      const unread: Array<{ module: string; r: Answer }> = [];
      for (const module of lookIn(ctx)) {
        const s = await call(ctx, `/crm/v2/${module}/search?phone=${PROBE}`);
        // Zoho checks the grant before it checks the number, so a refusal of the
        // made-up number itself still proves the search is allowed. Zennara's Zoho
        // answers "0000000000" with INVALID_DATA on phone; reading that as a failure
        // marked a working connection as broken.
        const probeRefused = s.status === 400 && verdict(s).code === "INVALID_DATA" && verdict(s).field === "phone";
        if (s.status < 400 || probeRefused) where.push(module);
        else if (judge(s) === "not-allowed") unread.push({ module, r: s });
        else return { ok: false, message: `Zoho answered a search in ${module} with ${s.status}: ${s.text.slice(0, 160)}` };
      }
      const cannot = unread.map((u) => `${u.module} (${said(u.r)})`).join(" or ");
      if (!where.length) {
        const why = cannot ? `Zoho would not let JENAI search ${cannot}` : "Not granted to read Leads or Contacts";
        return { ok: false, message: `Connected to Zoho CRM (${dcOf(ctx)}), but no caller can be found. ${why}: the grant needs ZohoSearch.securesearch.READ and the READ scope of Leads or Contacts.` };
      }
      for (const u of unread) await learn(ctx, u.r, scopeFor(u.module, "READ"));
      const finding = `Finding callers in ${where.join(", then ")}${cannot ? `; Zoho would not let JENAI search ${cannot}` : ""}.`;
      return { ok: true, message: `Connected to Zoho CRM (${dcOf(ctx)}). ${finding} ${writes(ctx)} ${shares(ctx)}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message.slice(0, 200) };
    }
  },

  async send(ctx, e): Promise<SendResult> {
    // What earlier tries already wrote, plus what this one writes.
    const done: Record<string, string> = { ...(e.progress ?? {}) };
    // The record once found, kept on a failed try so the retry does not search again.
    let at: Found | undefined;
    try {
      const say = writeup(e);
      // Only the fields they mapped. Without a mapping applyMapping hands back
      // the whole event, and that is not something to PUT on their record.
      const mapping = ctx.integration.mapping?.fields;
      const mapped = mapping && Object.keys(mapping).length ? applyMapping(e.payload, mapping) : {};
      // Skipped rather than done: nothing reached Zoho, so it says nothing about the connection.
      if (!say && !Object.keys(mapped).length) return { ok: false, retry: false, response: `Nothing to write in Zoho for ${e.kind}` };

      let got = await resolve(ctx, e);
      if ("result" in got) return got.result;
      at = got.at;
      let r = await writeOn(ctx, e, say, mapped, at, done);
      if ("gone" in r && got.remembered) {
        // The record we remembered for this person is not there any more. In a
        // clinic that is the usual life of a Lead: converted to a Contact once
        // they become a patient, or merged as a duplicate. Look again by
        // number, now, so this event lands on the record they keep today.
        const was = `${at.module} ${at.id}`;
        got = await resolve(ctx, { ...e, externalId: null, externalType: null });
        if ("result" in got) return { ...got.result, forget: true, progress: done, response: `The record we had for this person (${was}) is gone from Zoho. ${got.result.response ?? ""}`.slice(0, 1000) };
        at = got.at;
        r = await writeOn(ctx, e, say, mapped, at, done);
      }
      if ("gone" in r) return refused(r.gone, at, done);
      return r;
    } catch (err) {
      const gone = err instanceof GrantGoneError;
      return { ok: false, response: (err as Error).message.slice(0, 300), retry: !gone, connectionBroken: gone, externalId: at?.id, externalType: at?.module, progress: done };
    }
  },
};
