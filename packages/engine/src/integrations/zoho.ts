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

/** Zoho wants a wall-clock time with an offset, and a duration as mm:ss. */
function callTimes(p: Record<string, unknown>): { start: string; duration: string } {
  const c = (p.call ?? {}) as Record<string, unknown>;
  const at = new Date(String(c.at ?? c.started_at ?? new Date().toISOString()));
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 19);
  const secs = Math.max(0, Number(c.seconds ?? 0));
  return { start: `${ist}+05:30`, duration: `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}` };
}

interface Token {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

/** Zoho access tokens last an hour; the refresh token is the long-lived one we store. */
async function accessToken(ctx: ConnectorContext): Promise<string> {
  const cached = ctx.credentials.access_token;
  const until = Number(ctx.credentials.access_token_until ?? 0);
  if (cached && until > Date.now() + 60_000) return cached;
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
  if (!j.access_token) throw new Error(`Zoho refused the refresh token: ${j.error ?? res.status}`);
  await ctx.save({ credentials: { ...ctx.credentials, access_token: j.access_token, access_token_until: String(Date.now() + (j.expires_in ?? 3600) * 1000) } });
  ctx.credentials.access_token = j.access_token;
  ctx.credentials.access_token_until = String(Date.now() + (j.expires_in ?? 3600) * 1000);
  return j.access_token;
}

async function call(ctx: ConnectorContext, path: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const token = await accessToken(ctx);
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
  return { status: res.status, json, text };
}

/** Their record for this person: the one we linked before, else a phone search. */
async function findRecord(ctx: ConnectorContext, e: OutEvent): Promise<string | null> {
  if (e.externalId) return e.externalId;
  const phone = String((e.payload.person as Record<string, unknown> | undefined)?.phone ?? "");
  if (!phone) return null;
  const r = await call(ctx, `/crm/v2/${moduleOf(ctx)}/search?phone=${encodeURIComponent(phone)}`);
  const data = (r.json.data as Array<{ id?: string }> | undefined) ?? [];
  return data[0]?.id ?? null;
}

function noteText(p: Record<string, unknown>): { title: string; content: string } {
  const call = (p.call ?? {}) as Record<string, unknown>;
  const fields = (p.fields ?? {}) as Record<string, unknown>;
  const program = (p.program ?? {}) as Record<string, unknown>;
  const lines = [
    `Outcome: ${String(call.outcome ?? call.status ?? "unknown")}`,
    call.summary ? `Summary: ${String(call.summary)}` : "",
    Object.entries(fields).length ? `Answers: ${Object.entries(fields).map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`).join("; ")}` : "",
    call.seconds ? `Length: ${String(call.seconds)} seconds` : "",
    call.recording_url ? `Recording: ${String(call.recording_url)}` : "",
    `Made by JENAI (AI call)`,
  ].filter(Boolean);
  return { title: `JENAI call: ${String(program.name ?? "call")}`.slice(0, 120), content: lines.join("\n").slice(0, 32_000) };
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
    try {
      const id = await findRecord(ctx, e);
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
        const newId = ((created.json.data as Array<{ details?: { id?: string } }> | undefined) ?? [])[0]?.details?.id;
        if (!newId) return { ok: false, httpStatus: created.status, response: created.text, retry: retryable(created.status) };
        return this.send(ctx, { ...e, externalId: newId });
      }

      // How the call gets recorded, in order of what the client granted. A Call
      // record is the better home for it: it lands in their activity history
      // with a type, a time and a duration, rather than as loose text.
      const { title, content } = noteText(e.payload);
      let wrote = "nothing";
      let status = 200;
      if (may(ctx, "ZohoCRM.modules.calls.CREATE")) {
        const t = callTimes(e.payload);
        const direction = String(((e.payload.call ?? {}) as Record<string, unknown>).direction ?? "outbound");
        const r = await call(ctx, `/crm/v2/Calls`, {
          method: "POST",
          body: JSON.stringify({ data: [{
            Subject: title,
            Call_Type: direction === "inbound" ? "Inbound" : "Outbound",
            Call_Start_Time: t.start,
            Call_Duration: t.duration,
            Call_Status: "Completed",
            Description: content,
            Who_Id: id,
            $se_module: moduleOf(ctx),
          }] }),
        });
        if (r.status >= 400) return { ok: false, httpStatus: r.status, response: r.text, retry: retryable(r.status), externalId: id };
        wrote = "call logged";
        status = r.status;
      } else if (may(ctx, "ZohoCRM.modules.notes.CREATE")) {
        const r = await call(ctx, `/crm/v2/Notes`, {
          method: "POST",
          body: JSON.stringify({ data: [{ Note_Title: title, Note_Content: content, Parent_Id: id, se_module: moduleOf(ctx) }] }),
        });
        if (r.status >= 400) return { ok: false, httpStatus: r.status, response: r.text, retry: retryable(r.status), externalId: id };
        wrote = "note added";
        status = r.status;
      }

      // Fields the client chose to keep in step (for example Lead Status from the outcome).
      const fields = applyMapping(e.payload, ctx.integration.mapping?.fields);
      if (Object.keys(fields).length) {
        const upd = await call(ctx, `/crm/v2/${moduleOf(ctx)}/${id}`, { method: "PUT", body: JSON.stringify({ data: [fields] }) });
        if (upd.status >= 400) return { ok: false, httpStatus: upd.status, response: upd.text, retry: retryable(upd.status), externalId: id };
      }
      return { ok: true, httpStatus: status, externalId: id, response: `${wrote} on ${moduleOf(ctx)} ${id}` };
    } catch (err) {
      return { ok: false, response: (err as Error).message.slice(0, 300), retry: true };
    }
  },
};
