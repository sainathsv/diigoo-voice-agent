/**
 * The voice engine's side of the police server's SIP bridge:
 *
 *   department's SIP server <-SIP-> police server (Asterisk) <-ARI + audio WebSocket-> voice engine
 *
 * SIP stays on the office network. The engine controls each call through Asterisk's REST
 * interface (ARI, reached over Tailscale) and gets only the call's audio, over a WebSocket the
 * police server opens to it. Every call the SIP server sends goes to one extension, answered by
 * the CY Police agent.
 */
import type { DograhClient } from "@jenai/voice";

/** The engine's name for the bridge's telephony configuration (one per engine organization). */
export const SIP_BRIDGE_NAME = "Police server SIP bridge";

/** Where Asterisk streams each call's audio: the engine's ARI media WebSocket, from its base address. */
export function ariMediaUri(engineBaseUrl: string): string {
  return `${engineBaseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/v1/telephony/ws/ari`;
}

export interface SipBridgeInput {
  /** Asterisk's REST interface as the engine reaches it, e.g. http://100.69.176.71:8088 */
  ariEndpoint: string;
  ariUser: string;
  ariPassword: string;
  /** The websocket_client.conf section Asterisk streams audio through. */
  wsClientName: string;
  /** The extension every call from the SIP server is sent to. */
  extension: string;
  workflowId: number;
}

/**
 * Creates the bridge's Asterisk (ARI) configuration on the engine, or updates it in place (a new
 * password keeps the same Stasis application name), lets the engine use it again if it parked
 * it, and points the extension at the agent. Returns the Stasis application name the dialplan
 * must hand calls to: newer engines name it themselves; up to Dograh 1.35 it is the ARI user.
 */
export async function connectSipBridge(client: DograhClient, input: SipBridgeInput): Promise<{ configId: number; stasisApp: string; numberId: number }> {
  const config = { provider: "ari", ari_endpoint: input.ariEndpoint, app_name: input.ariUser, app_password: input.ariPassword, ws_client_name: input.wsClientName };
  const existing = (await client.listTelephonyConfigs()).configurations.find((c) => c.name === SIP_BRIDGE_NAME);
  const detail = existing ? await client.updateTelephonyConfig(existing.id, { config }) : await client.createTelephonyConfig({ name: SIP_BRIDGE_NAME, is_default_outbound: false, config });
  if (detail.inactive) await client.reactivateTelephonyConfig(detail.id);
  const stasisApp = String(detail.credentials?.stasis_app_name || input.ariUser);
  if (!/^[A-Za-z0-9_.-]+$/.test(stasisApp)) throw new Error("The voice engine did not give the bridge a Stasis application name.");
  const have = (await client.listPhoneNumbers(detail.id)).phone_numbers.find((n) => n.address === input.extension);
  const number = !have
    ? await client.addPhoneNumber(detail.id, { address: input.extension, label: "Government line, through the police server", inbound_workflow_id: input.workflowId })
    : have.inbound_workflow_id === input.workflowId
      ? have
      : await client.updatePhoneNumber(detail.id, have.id, { inbound_workflow_id: input.workflowId });
  return { configId: detail.id, stasisApp, numberId: number.id };
}
