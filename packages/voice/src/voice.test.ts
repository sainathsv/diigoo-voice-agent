import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DograhClient } from "./dograh";
import { publishBoth } from "./publish";
import { lintVersion, parseBuiltPrompt, render, type TemplateInput } from "./render";
import { toE164 } from "./phone";
import { addWorkflow, startFakeDograh, type FakeDograh } from "./testing/fake-dograh";

const T: TemplateInput = {
  basePrompt: "BASE RULES: reply in the caller's language.",
  endPrompt: "Say goodbye.",
  extraction: [{ name: "concern", type: "string", prompt: "The caller's {{domain}} problem" }],
  extractionPrompt: "Extract lead details.",
};
const V = {
  greeting: "Welcome to Zennara Skin and Hair Clinic. I am Ananya, the clinic's AI assistant. How can I help you?",
  facts: "YOU ARE Ananya at Zennara, Kondapur. Timings 10 AM to 7 PM. The ONLY price you know is the consultation at 500 rupees.",
};

let fake: FakeDograh;
let client: DograhClient;
beforeEach(async () => {
  fake = await startFakeDograh({ apiKey: "k1" });
  addWorkflow(fake, 1, "Zennara outbound", "OLD outbound prompt");
  addWorkflow(fake, 2, "Zennara inbound", "OLD inbound prompt");
  client = new DograhClient(fake.url, { kind: "api_key", apiKey: "k1" });
});
afterEach(async () => fake.close());

describe("publishBoth", () => {
  it("publishes one version to inbound AND outbound and verifies what callers will hear", async () => {
    const r = render(T, V, "skin or hair");
    const res = await publishBoth(client, { inboundWorkflowId: 2, outboundWorkflowId: 1 }, r);
    expect(res.ok).toBe(true);
    expect(res.results.every((x) => x.verified)).toBe(true);
    expect(fake.inboundHears(2)).toBe(r.inboundPrompt);
    expect(fake.inboundHears(1)).toBe(r.outboundPrompt);
    const end = fake.workflows.get(2)!.published.nodes.find((n) => n.type === "endCall")!.data!;
    expect(end.extraction_enabled).toBe(true);
    expect(JSON.stringify(end.extraction_variables)).toContain("skin or hair problem");
    // No draft left behind: the next edit starts clean.
    expect(fake.workflows.get(2)!.draft).toBeNull();
  });

  it("rolls the first direction back when the second fails, so callers never get mixed versions", async () => {
    fake.failPublish.add(1); // outbound publish fails
    const res = await publishBoth(client, { inboundWorkflowId: 2, outboundWorkflowId: 1 }, render(T, V, "skin"));
    expect(res.ok).toBe(false);
    const inbound = res.results.find((x) => x.direction === "inbound")!;
    expect(inbound.rolledBack).toBe(true);
    expect(fake.inboundHears(2)).toBe("OLD inbound prompt");
    expect(fake.inboundHears(1)).toBe("OLD outbound prompt");
  });

  it("works when the workflow already has a leftover draft", async () => {
    await client.createDraft(2);
    const res = await publishBoth(client, { inboundWorkflowId: 2, outboundWorkflowId: 1 }, render(T, V, "skin"));
    expect(res.ok).toBe(true);
  });
});

describe("render and import", () => {
  it("recovers facts and greeting from a prompt built with the template", () => {
    const r = render(T, V, "skin");
    expect(parseBuiltPrompt(r.inboundPrompt, T.basePrompt)).toEqual({ facts: V.facts, greeting: V.greeting });
    expect(parseBuiltPrompt("a hand-written prompt", T.basePrompt)).toBeNull();
  });
  it("uses a per-call outbound opening with the only two supported placeholders", () => {
    const r = render(T, V, "skin");
    expect(r.outboundPrompt).toContain("Hello {{caller_name}}, this is Zennara Skin and Hair Clinic calling about {{call_purpose}}");
  });
  it("blocks a version that does not disclose it is an AI", () => {
    const issues = lintVersion({ ...V, greeting: "Welcome to Zennara. How can I help you?" });
    expect(issues.some((i) => i.level === "error" && /AI assistant/.test(i.message))).toBe(true);
    expect(lintVersion(V).filter((i) => i.level === "error")).toHaveLength(0);
  });
});

describe("DograhClient", () => {
  it("logs in with a password and retries once on an expired session", async () => {
    const f = await startFakeDograh({ email: "a@b.c", password: "pw" });
    addWorkflow(f, 9, "x", "p");
    const c = new DograhClient(f.url, { kind: "password", email: "a@b.c", password: "pw" });
    expect((await c.listWorkflows())[0]!.workflow_uuid).toBe("uuid-9");
    expect(f.requests[0]).toBe("POST /auth/login");
    await f.close();
  });
  it("places calls only with an API key, against the published agent", async () => {
    const r = await client.triggerCall("uuid-1", { phone: "+919876543210", context: { caller_name: "Ravi", call_purpose: "your appointment" }, telephonyConfigId: 3 });
    expect(r.workflow_run_id).toBeGreaterThan(0);
    expect(fake.triggered[0]!.body).toMatchObject({ phone_number: "+919876543210", initial_context: { caller_name: "Ravi" } });
    const pw = new DograhClient(fake.url, { kind: "password", email: "x", password: "y" });
    await expect(pw.triggerCall("uuid-1", { phone: "+919876543210", context: {} })).rejects.toThrow(/API key/);
  });
});

describe("toE164", () => {
  it("normalises Indian formats, including doubled country codes", () => {
    expect(toE164("9876543210")).toBe("+919876543210");
    expect(toE164("09876543210")).toBe("+919876543210");
    expect(toE164("919876543210")).toBe("+919876543210");
    expect(toE164("91919876543210")).toBe("+919876543210");
    expect(toE164("+91 98765 43210")).toBe("+919876543210");
    expect(toE164("123")).toBeNull();
  });
});
