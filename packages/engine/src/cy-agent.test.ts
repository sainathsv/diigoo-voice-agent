/** The CY Police call script goes onto the live agent in place, against a stand-in voice engine. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { addWorkflow, startFakeDograh, type FakeDograh } from "@jenai/voice/testing";
import { DograhClient } from "@jenai/voice";
import { cyAgentParts, publishDefinition, withCyConversation, type CyProgram } from "./cy-agent";

const v3 = JSON.parse(readFileSync(new URL("../../db/seed-data/programs/police.cy_cybercrime_complaint.v3.json", import.meta.url), "utf8")) as CyProgram;
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
    const parts = cyAgentParts(v3);
    expect(parts.prompt).toContain("STEP 4. ON THE CALL, ONLY THREE THINGS");
    expect(parts.prompt).toContain("We are sharing a link on your WhatsApp number");
    expect(parts.prompt).toContain("नमस्ते, यह उत्तराखंड साइबर क्राइम पुलिस विभाग की हेल्पलाइन है।");
    expect(parts.prompt).toContain("complaint assistant of the Uttarakhand Cyber Crime Police Department.");
    expect(parts.prompt).not.toMatch(/CY Police/);
    expect(parts.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(parts.extraction.extraction_variables.map((v) => v.name)).toEqual(expect.arrayContaining(["whatsapp_consent", "whatsapp_number", "complainant_name"]));
  });

  it("changes only the conversation on the live agent, and can put the old one back", async () => {
    const r = await publishDefinition(client, 18, (d) => withCyConversation(d, cyAgentParts(v3)));
    expect(fake.inboundHears(18)).toContain("STEP 4. ON THE CALL, ONLY THREE THINGS");
    const start = fake.workflows.get(18)!.published.nodes.find((n) => n.type === "startCall")!.data!;
    expect(start.allow_interrupt).toBe(true); // other settings kept
    expect(start.extraction_enabled).toBe(true);
    expect(fake.workflows.get(18)!.tcv).toEqual({ department: "CY Police" });
    expect(fake.workflows.get(18)!.versions[0]!.status).toBe("published");
    expect(r.before.workflow_definition.nodes[0]!.data!.prompt).toBe("old script: take the whole form on the call");
    await publishDefinition(client, 18, () => r.before.workflow_definition);
    expect(fake.inboundHears(18)).toBe("old script: take the whole form on the call");
  });

  it("refuses an agent it does not recognise instead of guessing", () => {
    expect(() => withCyConversation({ nodes: [], edges: [] }, cyAgentParts(v3))).toThrow(/one Start step/);
  });
});
