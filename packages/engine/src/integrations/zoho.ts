import { assertClientUrl, toE164 } from "@jenai/voice";
import { CALL_DETAIL, HEALTH_DETAIL, applyMapping, retryable, type Connector, type ConnectorContext, type OutEvent, type SendResult } from "./types";

/**
 * Zoho CRM. The client keeps running Zoho exactly as they do today; JENAI adds
 * a note to the right record after every call, updates the fields they choose,
 * and can create a follow-up task. We never copy their database out.
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
  return { code: String(row.code ?? r.json.code ?? ""), message: String(row.message ?? r.json.message ?? ""), field: String(details.api_name ?? "") };
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

export const zohoConnector: Connector = {
  kind: "zoho_crm",

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
        if (s.status < 400) where.push(module);
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
