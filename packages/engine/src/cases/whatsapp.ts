import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { openSecret, platformDb, whatsappChannels, type Tx, type WhatsappChannel } from "@jenai/db";

/**
 * WhatsApp through OpenWA, a gateway on the client's own server that links a
 * normal WhatsApp number the way WhatsApp Web does. Messages are decrypted only
 * on that server; Meta relays them still encrypted. It is unofficial, and
 * WhatsApp restricts numbers that behave like bulk senders, so the helpline
 * only writes to people who called it or wrote first, one message at a time.
 * Until a number is linked a channel runs "simulated": messages are recorded in
 * the case thread and nothing is sent.
 */
export interface WhatsAppSender {
  readonly mode: "simulated" | "openwa";
  sendText(to: string, body: string): Promise<{ id: string }>;
  /** A photo, document or voice note the complainant sent, by the media id of the inbound message. */
  fetchMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string }>;
}

const MAX_MEDIA = 15 * 1024 * 1024;

/**
 * Someone WhatsApp shows only by a private id (…@lid), because it hides their number from
 * this account: their chat address here is "lid:<id>", and the complaint asks their number.
 */
export const lidAddress = (jid: string) => `lid:${jid.split("@")[0]!.replace(/\D/g, "")}`;
export const isLidAddress = (address: string) => address.startsWith("lid:");

/** "+91 98123 45678" becomes "919812345678@c.us", the chat id OpenWA addresses a person by; "lid:123" becomes "123@lid". */
export function chatIdFor(address: string): string {
  return isLidAddress(address) ? `${address.slice(4).replace(/\D/g, "")}@lid` : `${address.replace(/\D/g, "")}@c.us`;
}

/** The media id handleInbound passes to fetchMedia: the chat and the message it came in. */
export function openWaMediaId(chatId: string, messageId: string): string {
  return `${chatId}/${messageId}`;
}

export interface OpenWaSession {
  id: string;
  status: string;
  phone: string | null;
  lastError?: string | null;
}

export class OpenWaWhatsApp implements WhatsAppSender {
  readonly mode = "openwa" as const;
  constructor(
    private readonly baseUrl: string,
    readonly sessionId: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/api${path}`, {
      method,
      headers: { "X-API-Key": this.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, path, body);
    const j = (await r.json().catch(() => ({}))) as T & { message?: string | string[] };
    if (!r.ok) {
      const why = Array.isArray(j.message) ? j.message.join("; ") : (j.message ?? "no detail");
      throw new Error(`OpenWA refused ${method} ${path.replace(this.sessionId, ":session")} (${r.status}): ${why}`);
    }
    return j;
  }

  private get s() {
    return `/sessions/${encodeURIComponent(this.sessionId)}`;
  }

  async sendText(to: string, body: string) {
    const r = await this.call<{ messageId?: string }>("POST", `${this.s}/messages/send-text`, { chatId: chatIdFor(to), text: body.slice(0, 4096) });
    if (!r.messageId) throw new Error("OpenWA sent no message id");
    return { id: r.messageId };
  }

  async fetchMedia(mediaId: string) {
    const cut = mediaId.indexOf("/");
    if (cut < 1) throw new Error("Not an OpenWA media id");
    const [chatId, messageId] = [mediaId.slice(0, cut), mediaId.slice(cut + 1)];
    const r = await this.raw("GET", `${this.s}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`);
    if (!r.ok) throw new Error(`OpenWA media download failed (${r.status})`);
    if (Number(r.headers.get("content-length") ?? 0) > MAX_MEDIA) throw new Error("WhatsApp media is larger than 15 MB");
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_MEDIA) throw new Error("WhatsApp media is larger than 15 MB");
    return { bytes, mime: r.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
  }

  /** The phone number behind a privacy id (…@lid), when WhatsApp lets the account see it. */
  async resolvePhone(contactId: string): Promise<string | null> {
    const r = await this.call<{ phone?: string | null }>("GET", `${this.s}/contacts/${encodeURIComponent(contactId)}/phone`);
    return r.phone ? `+${r.phone.replace(/\D/g, "")}` : null;
  }

  session(): Promise<OpenWaSession> {
    return this.call<OpenWaSession>("GET", this.s);
  }

  /** The QR code to scan from the police phone (a PNG data URL), while the session waits for one. */
  async qr(): Promise<string | null> {
    const r = await this.call<{ qrCode?: string }>("GET", `${this.s}/qr`);
    return r.qrCode && r.qrCode.startsWith("data:image/") ? r.qrCode : null;
  }

  start(): Promise<OpenWaSession> {
    return this.call<OpenWaSession>("POST", `${this.s}/start`);
  }

  async logout(): Promise<void> {
    await this.call("POST", `${this.s}/logout`);
  }

  /** Points this session's events at the portal, signed with a fresh secret (replacing any earlier hook there). */
  async registerWebhook(url: string, secret: string): Promise<void> {
    const hooks = await this.call<Array<{ id: string; url: string }> | { data?: Array<{ id: string; url: string }> }>("GET", `${this.s}/webhooks`);
    const list = Array.isArray(hooks) ? hooks : (hooks.data ?? []);
    for (const h of list) if (h.url === url) await this.call("DELETE", `${this.s}/webhooks/${encodeURIComponent(h.id)}`);
    await this.call("POST", `${this.s}/webhooks`, { url, secret, events: ["message.received", "message.ack", "session.status", "session.authenticated", "session.disconnected"], retryCount: 5 });
  }

  /** Makes a session on the gateway; the id it returns is what the channel keeps. */
  static async createSession(baseUrl: string, apiKey: string, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    const r = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/sessions`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string | string[] };
    if (!r.ok || !j.id) throw new Error(`OpenWA could not create a session (${r.status}): ${Array.isArray(j.message) ? j.message.join("; ") : (j.message ?? "no id returned")}`);
    return j.id;
  }
}

/** Records what would have been sent. Used in tests and before a number is linked. */
export class SimulatedWhatsApp implements WhatsAppSender {
  readonly mode = "simulated" as const;
  readonly sent: Array<{ to: string; body: string }> = [];
  readonly media = new Map<string, { bytes: Buffer; mime: string }>();
  private n = 0;
  async sendText(to: string, body: string) {
    this.sent.push({ to, body });
    return { id: `sim-${Date.now()}-${++this.n}` };
  }
  async fetchMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error("No such simulated media");
    return m;
  }
}

export interface ChannelCredentials {
  apiKey: string;
  webhookSecret: string | null;
}

export function channelCredentials(ch: WhatsappChannel): ChannelCredentials | null {
  if (!ch.credentials) return null;
  try {
    const c = JSON.parse(openSecret(ch.tenantId, "whatsapp", ch.credentials)) as Partial<ChannelCredentials>;
    return c.apiKey ? { apiKey: c.apiKey, webhookSecret: c.webhookSecret ?? null } : null;
  } catch {
    return null;
  }
}

/** The gateway client for a channel, when it is set up for OpenWA. */
export function openWaFor(ch: WhatsappChannel, fetchImpl: typeof fetch = fetch): OpenWaWhatsApp | null {
  const creds = channelCredentials(ch);
  if (ch.mode !== "openwa" || !creds || !ch.openwaUrl || !ch.openwaSession) return null;
  return new OpenWaWhatsApp(ch.openwaUrl, ch.openwaSession, creds.apiKey, fetchImpl);
}

/** The workspace's WhatsApp channel and a sender for it; null when none is set up. */
export async function whatsappFor(tx: Tx, tenantId: string, override?: WhatsAppSender): Promise<{ channel: WhatsappChannel; sender: WhatsAppSender } | null> {
  const [channel] = await tx.select().from(whatsappChannels).where(eq(whatsappChannels.tenantId, tenantId)).limit(1);
  if (!channel || channel.status !== "active") return null;
  if (override) return { channel, sender: override };
  if (channel.mode === "openwa") {
    const gw = openWaFor(channel);
    return gw ? { channel, sender: gw } : null;
  }
  return { channel, sender: sharedSimulator };
}
const sharedSimulator = new SimulatedWhatsApp();

/**
 * Webhook routing: which workspace owns this OpenWA session. Platform pool on
 * purpose (the webhook has no login); it reads only the routing columns and
 * everything after runs inside the tenant.
 */
export async function channelByOpenWaSession(sessionId: string): Promise<WhatsappChannel | null> {
  if (!sessionId || sessionId.length > 120) return null;
  const [ch] = await platformDb().select().from(whatsappChannels).where(eq(whatsappChannels.openwaSession, sessionId)).limit(1);
  return ch ?? null;
}

/** OpenWA signs every delivery: X-OpenWA-Signature: sha256=<HMAC-SHA256 of the raw body>. */
export function validSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface InboundMessage {
  /** "+<digits>", or "lid:<id>" when WhatsApp hides the number (see lidAddress). */
  from: string;
  id: string;
  at: Date;
  /** The name the sender set in WhatsApp. */
  name?: string;
  text?: string;
  media?: { id: string; kind: "image" | "document" | "audio" | "video"; mime?: string; filename?: string; caption?: string; inline?: { bytes: Buffer; mime: string } };
}

/** A message as the webhook queues it (JSON-safe; the worker turns it into an InboundMessage). */
export interface QueuedMessage {
  id: string;
  chatId: string;
  /** "+<digits>" when WhatsApp showed the number; null for a privacy id the worker must resolve. */
  from: string | null;
  lid: string | null;
  at: string;
  name?: string;
  text?: string;
  media?: { kind: "image" | "document" | "audio" | "video"; mime?: string; filename?: string; dataBase64?: string };
}

export type OpenWaEvent =
  | { kind: "message"; sessionId: string; message: QueuedMessage }
  | { kind: "ack"; sessionId: string; id: string; status: string }
  | { kind: "link"; sessionId: string; status: string | null; phone: string | null }
  | { kind: "ignored"; sessionId: string; why: string };

const MEDIA_KINDS: Record<string, "image" | "document" | "audio" | "video"> = { image: "image", video: "video", audio: "audio", voice: "audio", ptt: "audio", document: "document" };

/** Reads one OpenWA webhook body. Groups, status updates, channels and our own messages are ignored. */
export function parseOpenWaWebhook(body: unknown): OpenWaEvent | null {
  const b = body as { event?: string; sessionId?: string; data?: Record<string, any> };
  if (!b || typeof b.event !== "string" || typeof b.sessionId !== "string") return null;
  const sessionId = b.sessionId;
  const d = b.data ?? {};
  if (b.event === "message.ack") {
    const id = String(d.messageId ?? d.id ?? "");
    return id ? { kind: "ack", sessionId, id, status: String(d.status ?? "") } : null;
  }
  if (b.event === "session.status") return { kind: "link", sessionId, status: d.status ? String(d.status) : null, phone: null };
  if (b.event === "session.authenticated") return { kind: "link", sessionId, status: "ready", phone: d.phone ? `+${String(d.phone).replace(/\D/g, "")}` : null };
  if (b.event === "session.disconnected") return { kind: "link", sessionId, status: "disconnected", phone: null };
  if (b.event !== "message.received") return { kind: "ignored", sessionId, why: b.event };

  const chatId = String(d.chatId ?? d.from ?? "");
  if (d.fromMe) return { kind: "ignored", sessionId, why: "own message" };
  if (d.isGroup || d.isStatusBroadcast || (d.kind && d.kind !== "individual") || !/@(c\.us|s\.whatsapp\.net|lid)$/.test(chatId)) return { kind: "ignored", sessionId, why: "not a one-to-one chat" };
  const sender = String(d.from ?? chatId);
  const isLid = sender.endsWith("@lid") || d.isLidSender === true;
  const phoneDigits = isLid ? String(d.senderPhone ?? d.contact?.senderPhone ?? "").replace(/\D/g, "") : sender.split("@")[0]!.replace(/\D/g, "");
  const type = String(d.type ?? "text").toLowerCase();
  const kind = MEDIA_KINDS[type];
  const text = typeof d.body === "string" && d.body.trim() ? d.body.slice(0, 4000) : undefined;
  const at = new Date(Number(d.timestamp) > 0 ? Number(d.timestamp) * 1000 : Date.now()).toISOString();
  const name = typeof d.contact?.pushName === "string" && d.contact.pushName.trim() ? d.contact.pushName.trim().slice(0, 80) : undefined;
  const message: QueuedMessage = { id: String(d.id ?? ""), chatId, from: phoneDigits.length >= 8 ? `+${phoneDigits}` : null, lid: isLid ? sender : null, at, ...(name ? { name } : {}), ...(text ? { text } : {}) };
  if (!message.id) return null;
  if (kind) {
    const m = (d.media ?? {}) as { mimetype?: string; filename?: string; data?: string; omitted?: boolean };
    message.media = { kind, mime: m.mimetype, filename: m.filename, ...(typeof m.data === "string" && m.data && !m.omitted ? { dataBase64: m.data.replace(/^data:[^,]*,/, "") } : {}) };
  } else if (!text) return { kind: "ignored", sessionId, why: `${type} message` };
  return { kind: "message", sessionId, message };
}
