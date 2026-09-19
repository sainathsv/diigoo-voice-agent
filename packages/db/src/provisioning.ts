/**
 * The go-live gate (Blueprint Part 11). A client stays in "onboarding" until
 * every required step has passed. Order matters: it is the onboarding sequence.
 */
export const PROVISIONING_STEPS = [
  { key: "kyc", label: "Business KYC verified", help: "GSTIN, PAN and signatory checked; telephony KYC in the client's own name.", required: true },
  { key: "telephony_account", label: "Own telephony account", help: "Carrier sub-account created for this client, or their own provider connected.", required: true },
  { key: "number", label: "Phone number assigned", help: "Landline for inbound and service, 140-series for promotional, 1600 for BFSI or government, or forwarding.", required: true },
  { key: "a2p_declaration", label: "A2P caller IDs declared", help: "Every caller ID used by AI declared to the operator (TRAI, 18 Sep 2026).", required: true },
  { key: "agent", label: "Agent configured and published", help: "Client facts filled in, disclosure line present, published to both inbound and outbound.", required: true },
  { key: "test_inbound", label: "Inbound test call passed", help: "Automatic call to the number answered by the published agent.", required: true },
  { key: "test_outbound", label: "Outbound test call passed", help: "Test call to the owner from the declared caller ID.", required: true },
  { key: "writeback", label: "Transcript and CRM write-back confirmed", help: "Transcript stored and the lead or booking reached the client's system.", required: true },
  { key: "wallet", label: "Plan chosen and wallet funded", help: "Subscription or prepaid balance in place.", required: true },
  { key: "dpa", label: "Data processing agreement signed", help: "Client is data fiduciary, JENAI is processor (DPDP).", required: true },
] as const;

export type ProvisioningStepKey = (typeof PROVISIONING_STEPS)[number]["key"];
