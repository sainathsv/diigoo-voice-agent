/** The OpenWA gateway client, against a local stand-in that answers like OpenWA's API. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BedrockCaseReader, LocalCaseReader, caseReaderFromEnv } from "./cases";
import { OpenWaWhatsApp, chatIdFor, keepConnected, openWaMediaId } from "./whatsapp";

let server: Server;
let base = "";
const seen: Array<{ method: string; path: string; key: string | undefined; body: unknown }> = [];
let hooks: Array<{ id: string; url: string }> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const path = decodeURIComponent(req.url ?? "");
    seen.push({ method: req.method ?? "", path, key: req.headers["x-api-key"] as string | undefined, body: raw ? JSON.parse(raw) : null });
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers["x-api-key"] !== "gw-key-0123456789abcdef0123456789") return json(401, { statusCode: 401, message: "Invalid API key" });
    if (req.method === "POST" && path === "/api/sessions") return json(201, { id: "sess-1", name: "cy-police", status: "created", phone: null });
    if (req.method === "POST" && path === "/api/sessions/sess-1/messages/send-text") return json(201, { messageId: "true_919812345678@c.us_3EB0AAA", timestamp: 1790000000 });
    if (req.method === "POST" && path === "/api/sessions/gone/messages/send-text") return json(409, { statusCode: 409, message: "Session is not connected" });
    if (req.method === "GET" && path === "/api/sessions/sess-1/messages/919812345678@c.us/false_919812345678@c.us_3EB0BBB/media") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(Buffer.from("jpeg-bytes"));
    }
    if (req.method === "GET" && path === "/api/sessions/sess-1/contacts/12345678901234@lid/phone") return json(200, { contactId: "12345678901234@lid", phone: "919800000009" });
    if (req.method === "GET" && path === "/api/sessions/sess-1/contacts/99@lid/phone") return json(200, { contactId: "99@lid", phone: null });
    if (req.method === "GET" && path === "/api/sessions/sess-1/qr") return json(200, { qrCode: "data:image/png;base64,iVBORw0KGgo=", status: "qr_ready" });
    if (req.method === "GET" && path === "/api/sessions/sess-1") return json(200, { id: "sess-1", status: "ready", phone: "919000011111" });
    // Dropped by a gateway restart, with the login kept; and one that was unlinked (no phone kept).
    if (req.method === "GET" && path === "/api/sessions/sess-down") return json(200, { id: "sess-down", status: "disconnected", phone: "919000011111" });
    if (req.method === "POST" && path === "/api/sessions/sess-down/start") return json(200, { id: "sess-down", status: "initializing", phone: "919000011111" });
    if (req.method === "GET" && path === "/api/sessions/sess-out") return json(200, { id: "sess-out", status: "disconnected", phone: null });
    if (req.method === "POST" && path === "/api/sessions/sess-1/start") return json(200, { id: "sess-1", status: "initializing", phone: null });
    if (req.method === "GET" && path === "/api/sessions/sess-1/webhooks") return json(200, hooks);
    if (req.method === "DELETE" && path.startsWith("/api/sessions/sess-1/webhooks/")) {
      hooks = hooks.filter((h) => h.id !== path.split("/").pop());
      return json(200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/sessions/sess-1/webhooks") {
      const b = JSON.parse(raw) as { url: string };
      hooks.push({ id: `wh-${hooks.length + 1}`, url: b.url });
      return json(201, { id: `wh-${hooks.length}` });
    }
    return json(404, { statusCode: 404, message: `no route ${req.method} ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const KEY = "gw-key-0123456789abcdef0123456789";

describe("OpenWA gateway client", () => {
  it("addresses a person by their WhatsApp chat id", () => {
    expect(chatIdFor("+91 98123 45678")).toBe("919812345678@c.us");
    expect(openWaMediaId("919812345678@c.us", "abc")).toBe("919812345678@c.us/abc");
  });

  it("creates a session and sends text with the API key", async () => {
    expect(await OpenWaWhatsApp.createSession(`${base}/`, KEY, "cy-police")).toBe("sess-1");
    const gw = new OpenWaWhatsApp(base, "sess-1", KEY);
    expect(await gw.sendText("+919812345678", "नमस्ते")).toEqual({ id: "true_919812345678@c.us_3EB0AAA" });
    const sent = seen.find((s) => s.path.endsWith("/send-text"))!;
    expect(sent.key).toBe(KEY);
    expect(sent.body).toEqual({ chatId: "919812345678@c.us", text: "नमस्ते" });
    // Someone WhatsApp shows only by a private id is answered on that chat.
    await gw.sendText("lid:12345678901234", "नमस्ते");
    expect(seen.filter((s) => s.path.endsWith("/send-text")).at(-1)!.body).toEqual({ chatId: "12345678901234@lid", text: "नमस्ते" });
  });

  it("reconnects a linked number the gateway dropped, and leaves an unlinked one for the QR code", async () => {
    expect(await keepConnected(new OpenWaWhatsApp(base, "sess-down", KEY))).toEqual({ status: "disconnected", phone: "919000011111", reconnecting: true });
    expect(seen.some((s) => s.method === "POST" && s.path === "/api/sessions/sess-down/start")).toBe(true);
    expect(await keepConnected(new OpenWaWhatsApp(base, "sess-out", KEY))).toMatchObject({ reconnecting: false });
    expect(seen.some((s) => s.path === "/api/sessions/sess-out/start")).toBe(false);
    expect(await keepConnected(new OpenWaWhatsApp(base, "sess-1", KEY))).toMatchObject({ status: "ready", reconnecting: false });
  });

  it("explains a refusal instead of failing quietly", async () => {
    await expect(new OpenWaWhatsApp(base, "gone", KEY).sendText("+919812345678", "hi")).rejects.toThrow(/409.*Session is not connected/);
    await expect(new OpenWaWhatsApp(base, "sess-1", "wrong-key").sendText("+919812345678", "hi")).rejects.toThrow(/401/);
  });

  it("downloads a photo the complainant sent", async () => {
    const m = await new OpenWaWhatsApp(base, "sess-1", KEY).fetchMedia(openWaMediaId("919812345678@c.us", "false_919812345678@c.us_3EB0BBB"));
    expect(m.bytes.toString()).toBe("jpeg-bytes");
    expect(m.mime).toBe("image/jpeg");
    await expect(new OpenWaWhatsApp(base, "sess-1", KEY).fetchMedia("no-slash")).rejects.toThrow(/Not an OpenWA media id/);
  });

  it("finds the phone number behind a privacy id when WhatsApp allows it", async () => {
    const gw = new OpenWaWhatsApp(base, "sess-1", KEY);
    expect(await gw.resolvePhone("12345678901234@lid")).toBe("+919800000009");
    expect(await gw.resolvePhone("99@lid")).toBeNull();
  });

  it("shows the QR code to link the police phone, and the link status", async () => {
    const gw = new OpenWaWhatsApp(base, "sess-1", KEY);
    expect(await gw.qr()).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect((await gw.session()).status).toBe("ready");
    expect((await gw.start()).status).toBe("initializing");
  });

  it("points the session's events at the portal, replacing an earlier hook to the same address", async () => {
    const gw = new OpenWaWhatsApp(base, "sess-1", KEY);
    hooks = [{ id: "old-1", url: "http://host.docker.internal:8086/api/whatsapp/openwa" }, { id: "other", url: "https://elsewhere.example/hook" }];
    await gw.registerWebhook("http://host.docker.internal:8086/api/whatsapp/openwa", "s3cret-s3cret-16chars");
    expect(hooks.map((h) => h.url)).toEqual(["https://elsewhere.example/hook", "http://host.docker.internal:8086/api/whatsapp/openwa"]);
    const created = seen.filter((s) => s.method === "POST" && s.path === "/api/sessions/sess-1/webhooks").at(-1)!;
    expect(created.body).toMatchObject({ secret: "s3cret-s3cret-16chars", events: expect.arrayContaining(["message.received", "message.ack", "session.status"]) });
  });
});

describe("reading WhatsApp replies", () => {
  it("uses the model on this server, and never one off its own network in the police edition", () => {
    const local = { JENAI_ANALYZER_PROVIDER: "local", JENAI_ANALYZER_BASE_URL: "http://127.0.0.1:11434/v1", JENAI_ANALYZER_MODEL: "jenai-analyzer" };
    expect(caseReaderFromEnv(local).ai).toBeInstanceOf(LocalCaseReader);
    expect(caseReaderFromEnv({ ...local, JENAI_EDITION: "police" }).ai).toBeInstanceOf(LocalCaseReader);
    expect(() => caseReaderFromEnv({ ...local, JENAI_EDITION: "police", JENAI_ANALYZER_BASE_URL: "https://api.openai.com/v1" })).toThrow(/own network/);
    expect(() => caseReaderFromEnv({ JENAI_EDITION: "police", JENAI_ANALYZER_PROVIDER: "bedrock" })).toThrow(/police edition/);
    expect(caseReaderFromEnv({}).ai).toBeInstanceOf(BedrockCaseReader);
    // A police server without an AI of its own still reads the plain answers.
    expect(caseReaderFromEnv({ JENAI_EDITION: "police" }).ai).toBeNull();
    expect(() => caseReaderFromEnv({ JENAI_EDITION: "police", JENAI_ANALYZER_PROVIDER: "local" })).toThrow(/needs JENAI_ANALYZER_BASE_URL/);
  });
});
