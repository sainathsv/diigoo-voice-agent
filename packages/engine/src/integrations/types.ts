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
  payload: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  httpStatus?: number;
  /** Their record id, when the connector created or found one. */
  externalId?: string;
  response?: string;
  /** false for a permanent refusal (bad request, revoked access): stop retrying. */
  retry?: boolean;
}

export interface Connector {
  kind: IntegrationKind;
  /** A one-line answer for the client: does this connection work right now. */
  test(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }>;
  send(ctx: ConnectorContext, e: OutEvent): Promise<SendResult>;
}

/** Reads a value out of the event payload by a dotted path, for field mapping. */
export function pick(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((v, part) => (v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined), payload);
}

/** Builds the body their system expects: {theirField: "our.path"} becomes {theirField: value}. */
export function applyMapping(payload: Record<string, unknown>, mapping: Record<string, string> | undefined): Record<string, unknown> {
  if (!mapping || !Object.keys(mapping).length) return payload;
  const out: Record<string, unknown> = {};
  for (const [theirs, ours] of Object.entries(mapping)) {
    const v = pick(payload, ours);
    if (v !== undefined && v !== null && v !== "") out[theirs] = v;
  }
  return out;
}

/** Network and 5xx answers are worth retrying; a refusal is not. */
export function retryable(status: number | undefined): boolean {
  if (status === undefined) return true; // never reached them
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}
