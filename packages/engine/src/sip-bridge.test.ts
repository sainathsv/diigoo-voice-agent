/** The voice engine's side of the police server's SIP bridge, against a stand-in voice engine. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeDograh, type FakeDograh } from "@jenai/voice/testing";
import { DograhClient } from "@jenai/voice";
import { SIP_BRIDGE_NAME, ariMediaUri, connectSipBridge } from "./sip-bridge";

let fake: FakeDograh;
let client: DograhClient;
const input = { ariEndpoint: "http://100.69.176.71:8088", ariUser: "jenai", ariPassword: "first-password-0123456789", wsClientName: "dograh", extension: "1930", workflowId: 18 };

beforeAll(async () => {
  fake = await startFakeDograh({ apiKey: "k-test" });
  client = new DograhClient(fake.url, { kind: "api_key", apiKey: "k-test" });
});
afterAll(() => fake.close());

describe("SIP bridge on the voice engine", () => {
  it("streams each call's audio to the engine's ARI WebSocket", () => {
    expect(ariMediaUri("https://voice.jenai.in")).toBe("wss://voice.jenai.in/api/v1/telephony/ws/ari");
    expect(ariMediaUri("http://10.0.0.5:8000/")).toBe("ws://10.0.0.5:8000/api/v1/telephony/ws/ari");
  });

  it("adds an Asterisk connection, and the extension every government-line call goes to, answered by the agent", async () => {
    const r = await connectSipBridge(client, input);
    expect(r.stasisApp).toMatch(/^dograh_[0-9a-f]{12}$/);
    const bridge = fake.telephony.find((t) => t.name === SIP_BRIDGE_NAME)!;
    expect(bridge).toMatchObject({ provider: "ari", is_default_outbound: false });
    expect(bridge.credentials).toMatchObject({ ari_endpoint: "http://100.69.176.71:8088", app_name: "jenai", app_password: "first-password-0123456789", ws_client_name: "dograh", stasis_app_name: r.stasisApp });
    expect(bridge.numbers).toEqual([expect.objectContaining({ address: "1930", inbound_workflow_id: 18 })]);
    expect(fake.telephony.find((t) => t.name === "Vobiz")!.numbers).toHaveLength(1); // the existing line is left alone
  });

  it("is updated in place when set up again: a new password, the same Stasis application, one extension, used again if the engine parked it", async () => {
    const first = fake.telephony.find((t) => t.name === SIP_BRIDGE_NAME)!;
    const app = first.credentials.stasis_app_name;
    first.inactive = true;
    first.numbers[0]!.inbound_workflow_id = 7;
    const r = await connectSipBridge(client, { ...input, ariPassword: "second-password-0123456789" });
    expect(fake.telephony.filter((t) => t.name === SIP_BRIDGE_NAME)).toHaveLength(1);
    expect(r.stasisApp).toBe(app);
    expect(first.credentials.app_password).toBe("second-password-0123456789");
    expect(first.inactive).toBe(false);
    expect(first.numbers).toEqual([expect.objectContaining({ address: "1930", inbound_workflow_id: 18 })]);
  });

  it("on an engine up to Dograh 1.35, hands calls to the ARI user, which is the Stasis application there", async () => {
    const older = await startFakeDograh({ apiKey: "k-test" });
    older.legacyAri = true;
    try {
      const r = await connectSipBridge(new DograhClient(older.url, { kind: "api_key", apiKey: "k-test" }), input);
      expect(r.stasisApp).toBe("jenai");
      const bridge = older.telephony.find((t) => t.name === SIP_BRIDGE_NAME)!;
      expect(bridge.credentials).not.toHaveProperty("stasis_app_name");
      expect(bridge.numbers).toEqual([expect.objectContaining({ address: "1930", inbound_workflow_id: 18 })]);
    } finally {
      await older.close();
    }
  });
});
