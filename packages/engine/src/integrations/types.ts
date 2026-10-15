import type { Integration, IntegrationKind } from "@jenai/db";

/**
 * A connector hands one event to the client's own system, or answers a request
 * from it. The client's system stays the record of truth: JENAI never asks for
 * their database, only for what a call needs, and hands back what happened.
 */
export interface ConnectorContext {
  integration: Integration;
  /** Opened credentials (sealed per tenant in the database). */
  credentials: Record<string, string>;
  fetch: typeof fetch;
  /** Persist refreshed tokens or config (OAuth refresh, discovered ids). */
  save(patch: { credentials?: Record<string, string>; config?: Record<string, unknown> }): Promise<void>;
}

export interface OutEvent {
  id: string;
  kind: string;
  idempotencyKey: string;
  /** Their record this is about, when we know it. */
  externalId: string | null;
  /**
   * Which kind of record externalId is, for a system that keeps people in more
   * than one place (Zoho's Leads and Contacts). Null when not known.
   */
  externalType?: string | null;
  payload: Record<string, unknown>;
  /**
   * What an earlier try already wrote in their system, as the connector named
   * it ({Calls: "<id>"}). A connector that makes more than one request for an
   * event skips the ones listed here, so a retry never writes them twice.
   */
  progress?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  httpStatus?: number;
  /** Their record id, when the connector created or found one. */
  externalId?: string;
  /** Which kind of record that is (Zoho's Leads or Contacts), kept beside the id. */
  externalType?: string;
  response?: string;
  /**
   * false for a permanent refusal: stop retrying. On its own that refusal is
   * about this one record (not in their CRM, a stale id, a value they reject):
   * the event is skipped with its reason and the connection stays up.
   */
  retry?: boolean;
  /**
   * The refusal is about the connection itself: a revoked grant, a scope their
   * admin did not give, an address we will not send to. Nothing else would get
   * through either, so the integration is marked broken until someone
   * reconnects it. Never set for a refusal about one record.
   */
  connectionBroken?: boolean;
  /**
   * Everything written in their system for this event so far, by this try and
   * the ones before it. Kept on the event whatever the outcome, and handed back
   * on the next try as OutEvent.progress.
   */
  progress?: Record<string, string>;
  /**
   * The record we remembered for this person is gone from their system
   * (converted, merged or deleted) and no other was found. The event and the
   * person's link let go of it, so the next event searches afresh.
   */
  forget?: boolean;
}

/**
 * One record read from their system, cut down to what the call plan uses.
 * Their free-text notes never travel in it: only a date read out of them.
 */
export interface PulledRecord {
  externalId: string;
  module: string;
  modifiedAt: Date | null;
  createdAt: Date | null;
  /** E.164, or null when no number on the record can be dialled. */
  phone: string | null;
  name: string | null;
  status: string | null;
  source: string | null;
  centre: string | null;
  appointmentAt: Date | null;
  /** False when their field held a date only: no time of day to remind them of. Null with no appointment. */
  appointmentHasTime: boolean | null;
  /** Their follow-up field, or else a callback date the team wrote in their notes. */
  followUpAt: Date | null;
  /** The team wrote in the notes not to call this person. Only this answer travels, never the notes. */
  notesSayDoNotCall: boolean;
  treatment: string | null;
  consultant: string | null;
}

export interface PullInput {
  module: string;
  /** Where this module got to last time, as the connector left it. Empty on the first read. */
  cursor: Record<string, unknown>;
  /** Requests for records this read may make, at most. */
  pageBudget: number;
  /** The client's time zone, for a date written without a time. */
  timeZone?: string;
}

export interface PullResult {
  records: PulledRecord[];
  /** Records their system says were deleted or merged away since the last read. */
  deleted: Array<{ externalId: string; deletedAt: Date }>;
  /** Where to start next time. Stored only once the records above are. */
  cursor: Record<string, unknown>;
  /** Nothing more to read for now; false when the page budget ran out first. */
  done: boolean;
  /** Requests for records this read made, against the budget. */
  pages: number;
  /** Why the module was not read at all, in plain words (a scope not granted). */
  skipped?: string;
  /** What stopped the read part way. The records before it are still good. */
  error?: string;
  /** Things worth knowing that did not stop the read. */
  notes?: string[];
  /** The read moved past where earlier reads had got to: there may be more to read at once. */
  advanced?: boolean;
  /** This read is part of reading the module again in full: store every record, changed or not. */
  rereading?: boolean;
  /**
   * A full read of the module ended: a record of it stored before this time
   * and not read since is gone from their system.
   */
  sweepBefore?: Date;
  /** Their system refused the connection itself (a revoked grant): reading again will not help until it is reconnected. */
  connectionBroken?: boolean;
}

export interface Connector {
  kind: IntegrationKind;
  /** A one-line answer for the client: does this connection work right now. */
  test(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }>;
  send(ctx: ConnectorContext, e: OutEvent): Promise<SendResult>;
  /**
   * Whether this connection would write anything for a kind of event. False
   * means the event is not queued for it at all, rather than queued and then
   * skipped with "nothing to write", which buries the skips that matter.
   */
  wants?(integration: Integration, kind: string): boolean;
  /**
   * Reads what changed in one of their modules since the cursor, for the call
   * plan. Read only: nothing is written to their system.
   */
  pull?(ctx: ConnectorContext, input: PullInput): Promise<PullResult>;
  /** The modules read when the client has not chosen their own (config.pull.modules). */
  pullModules?: string[];
}

/** Reads a value out of the event payload by a dotted path, for field mapping. */
export function pick(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((v, part) => (v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined), payload);
}

/**
 * Builds the body their system expects: {theirField: "our.path"} becomes {theirField: value}.
 * With no mapping it is the whole payload, which suits a webhook; a CRM
 * connector checks for a mapping first, or it writes the raw event on a record.
 */
export function applyMapping(payload: Record<string, unknown>, mapping: Record<string, string> | undefined): Record<string, unknown> {
  if (!mapping || !Object.keys(mapping).length) return payload;
  const out: Record<string, unknown> = {};
  for (const [theirs, ours] of Object.entries(mapping)) {
    const v = pick(payload, ours);
    if (v !== undefined && v !== null && v !== "") out[theirs] = v;
  }
  return out;
}

/**
 * Health detail the standard questions gather on every call: the history the
 * advisor asks for (how long, what they tried, background, the advice given,
 * whether it is urgent) and a problem a follow-up or feedback call hears
 * about. It stays in JENAI, under the client's tenant like the transcript,
 * unless they choose to hand it on.
 */
export const HEALTH_DETAIL = ["duration", "tried_before", "background", "advice_given", "urgent", "problem_reported", "complication_reported"];

/**
 * What a call says outside its answers that can carry health detail, by the
 * name a share list (config.share) uses for it, and the keys it fills under
 * payload.call: the model's summary of the conversation, what they asked
 * about, the link to the recording, and how the call ended.
 */
export const CALL_DETAIL: Record<string, string[]> = {
  summary: ["summary"],
  concern: ["concern"],
  recording: ["recording_url", "recording_expires_at"],
  outcome: ["outcome", "outcome_label"],
};

/**
 * What one event holds back unless a share list names it, decided where the
 * event is made, which is the only place that knows the call's program.
 */
export interface Withheld {
  /** Answer keys (payload.fields) and CALL_DETAIL names. */
  names: string[];
  /** What call.outcome reads when the outcome is held back: its lead stage, which says no more than the lead does. */
  outcome?: string | null;
}

/**
 * The event as one connection is handed it. A CRM is read by the whole front
 * office and a webhook goes wherever their developer points it, so health
 * detail goes only where the client said it may.
 *
 * Of the call's answers (payload.fields), only the ones its share list names,
 * or, with no list, all but the health detail and what the event holds back.
 * What the event holds back outside the answers (a health call's summary, for
 * one) is emptied unless the list names it. The keys stay, empty, so a
 * client's code reading them does not break.
 */
export function sharedWith(config: Record<string, unknown>, payload: Record<string, unknown>, withheld: Withheld = { names: [] }): Record<string, unknown> {
  const list = Array.isArray(config.share) ? config.share.map(String) : null;
  const held = (name: string) => withheld.names.includes(name) && !list?.includes(name);
  const out = { ...payload };
  const fields = payload.fields;
  if (fields && typeof fields === "object") {
    out.fields = Object.fromEntries(Object.entries(fields).filter(([k]) => (list ? list.includes(k) : !HEALTH_DETAIL.includes(k) && !held(k))));
  }
  const call = payload.call;
  if (call && typeof call === "object") {
    const c = { ...(call as Record<string, unknown>) };
    for (const [name, keys] of Object.entries(CALL_DETAIL)) {
      if (!held(name)) continue;
      for (const k of keys) if (k in c) c[k] = null;
      if (name === "outcome" && "outcome" in c) c.outcome = withheld.outcome ?? null;
    }
    out.call = c;
  }
  return out;
}

/** Network and 5xx answers are worth retrying; a refusal is not. */
export function retryable(status: number | undefined): boolean {
  if (status === undefined) return true; // never reached them
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}
