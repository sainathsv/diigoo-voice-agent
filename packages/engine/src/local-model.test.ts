/** The on-premise analyser: an OpenAI-compatible model on the client's own server. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BedrockExtractor, LocalModelExtractor, extractorFromEnv } from "./analyze";

let server: Server;
let base = "";
const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const input = { transcript: "user: mere 40000 kat gaye", startedAt: new Date("2026-10-01T05:00:00Z"), domain: "cyber crime", direction: "inbound" as const, program: null };

describe("local model analyser", () => {
  it("asks the local model for JSON and returns its answer", async () => {
    reply = { status: 200, body: { choices: [{ message: { content: '{"summary":"Lost 40000","caller_name":null}' } }] } };
    const out = await new LocalModelExtractor("qwen2.5:7b", base).extract(input);
    expect(out).toBe('{"summary":"Lost 40000","caller_name":null}');
    const req = seen.at(-1)!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.auth).toBeUndefined(); // a local server needs no key
    expect(req.body).toMatchObject({ model: "qwen2.5:7b", temperature: 0, response_format: { type: "json_object" } });
    expect(String((req.body.messages as Array<{ content: string }>)[0]!.content)).toContain("police cyber crime helpline");
  });

  it("sends a key when the local server is set up with one", async () => {
    reply = { status: 200, body: { choices: [{ message: { content: "{}" } }] } };
    await new LocalModelExtractor("m", `${base}/`, "local-secret").extract(input);
    expect(seen.at(-1)!.auth).toBe("Bearer local-secret");
    expect(seen.at(-1)!.path).toBe("/v1/chat/completions"); // trailing slash handled
  });

  it("reports a refused request instead of saving nothing", async () => {
    reply = { status: 404, body: { error: { message: "model 'nope' not found" } } };
    await expect(new LocalModelExtractor("nope", base).extract(input)).rejects.toThrow(/404.*model 'nope' not found/);
  });

  it("is chosen by configuration, and refuses a half-configured one", () => {
    const local = extractorFromEnv({ JENAI_ANALYZER_PROVIDER: "local", JENAI_ANALYZER_BASE_URL: base, JENAI_ANALYZER_MODEL: "qwen2.5:7b" });
    expect(local).toBeInstanceOf(LocalModelExtractor);
    expect(local.model).toBe("qwen2.5:7b");
    expect(() => extractorFromEnv({ JENAI_ANALYZER_PROVIDER: "local", JENAI_ANALYZER_MODEL: "x" })).toThrow(/JENAI_ANALYZER_BASE_URL/);
    expect(() => extractorFromEnv({ JENAI_ANALYZER_PROVIDER: "gpt-cloud" })).toThrow(/Unknown/);
    expect(extractorFromEnv({})).toBeInstanceOf(BedrockExtractor);
  });

  it("never sends a police server's transcripts off its own network", () => {
    const police = { JENAI_EDITION: "police", JENAI_ANALYZER_MODEL: "gemma3:12b" };
    expect(() => extractorFromEnv(police)).toThrow(/JENAI_ANALYZER_BASE_URL/); // local is the default there
    expect(() => extractorFromEnv({ ...police, JENAI_ANALYZER_PROVIDER: "bedrock" })).toThrow(/police edition/);
    for (const far of ["https://api.openai.com/v1", "http://8.8.8.8:11434/v1", "http://ollama.example.com/v1", "http://[2001:4860::8888]:11434/v1", "not a url"])
      expect(() => extractorFromEnv({ ...police, JENAI_ANALYZER_BASE_URL: far }), far).toThrow(/own network/);
    for (const near of ["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1", "http://192.168.2.185:11434/v1", "http://10.0.0.5:8000/v1", "http://172.20.0.2:11434/v1", "http://100.69.176.71:11434/v1", "http://ollama:11434/v1", "http://[fd7a:115c:a1e0::1]:11434/v1"])
      expect(extractorFromEnv({ ...police, JENAI_ANALYZER_BASE_URL: near }), near).toBeInstanceOf(LocalModelExtractor);
  });
});
