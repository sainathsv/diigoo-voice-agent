/** The CY Police call script goes onto the live agent in place, against a stand-in voice engine. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { addWorkflow, startFakeDograh, type FakeDograh } from "@jenai/voice/testing";
import { DograhClient } from "@jenai/voice";
import { CY_CALL_SETTINGS, CY_VOICE, cyAgentParts, publishDefinition, withCyConversation, withStatusLookup, withVoice, type CyProgram } from "./cy-agent";

const v5 = JSON.parse(readFileSync(new URL("../../db/seed-data/programs/police.cy_cybercrime_complaint.v5.json", import.meta.url), "utf8")) as CyProgram;
let fake: FakeDograh;
let client: DograhClient;

beforeAll(async () => {
  fake = await startFakeDograh({ apiKey: "k-test" });
  addWorkflow(fake, 18, "CY Police Cyber Complaint", "old script: take the whole form on the call");
  fake.workflows.get(18)!.tcv = { department: "CY Police" };
  fake.workflows.get(18)!.published.nodes[0]!.data = { ...fake.workflows.get(18)!.published.nodes[0]!.data, allow_interrupt: true, name: "Start" };
  client = new DograhClient(fake.url, { kind: "api_key", apiKey: "k-test" });
});
afterAll(() => fake.close());

describe("CY Police phone agent", () => {
  it("builds the three-question script with the greeting that has no AI line", () => {
    const parts = cyAgentParts(v5);
    expect(parts.prompt).toContain("STEP 4. ON THE CALL, ONLY THREE THINGS");
    expect(parts.prompt).toContain("We are sharing a link on your WhatsApp number");
    expect(parts.prompt).toContain("नमस्ते, यह उत्तराखंड साइबर क्राइम पुलिस विभाग की हेल्पलाइन है।");
    expect(parts.prompt).toContain("complaint assistant of the Uttarakhand Cyber Crime Police Department.");
    expect(parts.prompt).not.toMatch(/CY Police/);
    expect(parts.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(parts.extraction.extraction_variables.map((v) => v.name)).toEqual(expect.arrayContaining(["whatsapp_consent", "whatsapp_number", "complainant_name"]));
  });

  it("never promises a call back, ends the call itself after the WhatsApp line, and gives the status of a complaint already registered", () => {
    const parts = cyAgentParts(v5);
    for (const text of [parts.prompt, parts.endPrompt]) {
      expect(text).not.toMatch(/(officer|someone|they) (will|shall) (call|contact) (you|them)( back)?/i);
      expect(text).not.toMatch(/call you back on this number/i);
    }
    expect(parts.prompt).toContain("Never say that an officer or anyone will call them back");
    expect(parts.prompt).toContain("Right after saying one of these, END THE CALL.");
    expect(parts.prompt).toContain("ENDING THE CALL.");
    // The status comes from the lookup at the start of the call when it is on, "none" otherwise.
    expect(parts.prompt).toContain("{{complaint_status | fallback:not checked}}");
    expect(parts.prompt).toContain("Your complaint is In Progress, and the Uttarakhand Police is working on it.");
    expect(parts.prompt).toContain("आपकी शिकायत पर काम चल रहा है (In Progress), उत्तराखंड पुलिस इस पर काम कर रही है।");
    expect(parts.endPrompt).toContain("Never say that anyone will call them back");
  });

  it("asks a caller with a complaint on record first, takes the date the money left, keeps one language and handles interruptions and noise", () => {
    const parts = cyAgentParts(v5);
    // The opening asks first when the police server's lookup found a complaint; otherwise the usual opening.
    expect(parts.prompt).toContain("यह कॉल रिकॉर्ड हो रही है। {{status_greeting | fallback:आप हिंदी या English में बात कर सकते हैं। बताइए क्या हुआ है");
    expect(parts.prompt).toContain("status {{complaint_status | fallback:not checked}}");
    expect(parts.prompt).toContain("this helpline takes money fraud complaints only within 3");
    expect(parts.prompt).toContain("Today is {{current_time_Asia/Kolkata | fallback:today}}");
    expect(parts.prompt).toContain("KUMAONI AND GARHWALI ARE NOT NEPALI.");
    expect(parts.prompt).toContain("CHOOSE THE LANGUAGE ONCE, THEN KEEP IT.");
    expect(parts.prompt).not.toContain("Reply in the language of the caller's LAST sentence");
    expect(parts.prompt).toContain("WHEN THE CALLER INTERRUPTS YOU");
    expect(parts.prompt).toContain("NOISE AND UNCLEAR SPEECH");
    expect(parts.prompt).toContain('by calling the function\nnamed "end"');
    expect(parts.extraction.extraction_variables.map((v) => v.name)).toEqual(expect.arrayContaining(["transaction_date", "within_3_days", "call_intent"]));
    expect(parts.extraction.extraction_prompt).toContain("Today is {{current_time_Asia/Kolkata");
  });

  it("changes the conversation, the rule for ending the call and the call limits, and can put the old one back", async () => {
    const r = await publishDefinition(client, 18, (d) => withCyConversation(d, cyAgentParts(v5)), (c) => ({ ...c, ...CY_CALL_SETTINGS }));
    expect(fake.inboundHears(18)).toContain("STEP 4. ON THE CALL, ONLY THREE THINGS");
    const wf = fake.workflows.get(18)!;
    const start = wf.published.nodes.find((n) => n.type === "startCall")!.data!;
    expect(start.allow_interrupt).toBe(true); // other settings kept
    expect(start.extraction_enabled).toBe(true);
    expect((wf.published.edges[0] as { data: { condition: string } }).data.condition).toMatch(/^END THE CALL NOW: right after you have told them what happens on WhatsApp/);
    expect(wf.configs).toEqual({ max_call_duration: 600, max_user_idle_timeout: 10 });
    expect(wf.tcv).toEqual({ department: "CY Police" });
    expect(wf.versions[0]!.status).toBe("published");
    expect(r.before.workflow_definition.nodes[0]!.data!.prompt).toBe("old script: take the whole form on the call");
    await publishDefinition(client, 18, () => r.before.workflow_definition, () => r.before.workflow_configurations ?? {});
    expect(fake.inboundHears(18)).toBe("old script: take the whole form on the call");
    expect(fake.workflows.get(18)!.configs).toEqual({});
  });

  it("asks this server for the caller's complaint status at the start of each call, with a token the engine keeps", async () => {
    const cred = await client.saveBearerCredential("JENAI complaint status", "tok-1", "status lookup");
    expect((await client.saveBearerCredential("JENAI complaint status", "tok-2", "status lookup")).uuid).toBe(cred.uuid); // replaced, not duplicated
    expect(fake.credentials).toHaveLength(1);
    expect(fake.credentials[0]!.credential_data).toEqual({ token: "tok-2" });
    const def = withStatusLookup(withCyConversation(fake.workflows.get(18)!.published, cyAgentParts(v5)), { url: "http://100.69.176.71:8087/api/voice/precall", credentialUuid: cred.uuid });
    expect(def.nodes.find((n) => n.type === "startCall")!.data).toMatchObject({ pre_call_fetch_mode: "inbound", pre_call_fetch_url: "http://100.69.176.71:8087/api/voice/precall", pre_call_fetch_credential_uuid: cred.uuid });
  });

  it("refuses an agent it does not recognise instead of guessing", () => {
    expect(() => withCyConversation({ nodes: [], edges: [] }, cyAgentParts(v5))).toThrow(/one Start step/);
    expect(() => withCyConversation({ nodes: [{ id: "1", type: "startCall", data: {} }], edges: [] }, cyAgentParts(v5))).toThrow(/from Start to End/);
  });
});

describe("the CY Police agent's voice", () => {
  it("is male, set on the agent only: as an override of the organization's live voice, keeping other overrides", () => {
    expect(CY_VOICE).toBe("Charon");
    expect(withVoice({ max_call_duration: 600 }, CY_VOICE)).toEqual({ max_call_duration: 600, model_overrides: { realtime: { voice: "Charon" } } });
    expect(withVoice({ model_overrides: { is_realtime: true, realtime: { model: "m" } } }, CY_VOICE)).toEqual({ model_overrides: { is_realtime: true, realtime: { model: "m", voice: "Charon" } } });
  });

  it("is set inside the agent's own complete model settings when it has them, its masked key left for the engine to keep", () => {
    const own = { version: 2, mode: "byok", byok: { mode: "realtime", realtime: { realtime: { provider: "google_realtime", voice: "Leda", api_key: "****" }, llm: { provider: "google" } } } };
    const out = withVoice({ model_configuration_v2_override: own }, CY_VOICE) as { model_configuration_v2_override: typeof own };
    expect(out.model_configuration_v2_override.byok.realtime.realtime).toEqual({ provider: "google_realtime", voice: "Charon", api_key: "****" });
    expect(out.model_configuration_v2_override.byok.realtime.llm).toEqual({ provider: "google" });
    expect(out).not.toHaveProperty("model_overrides");
  });
});
