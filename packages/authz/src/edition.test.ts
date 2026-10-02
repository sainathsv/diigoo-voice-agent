/** The police edition serves the complaint portal and nothing else. */
import { describe, expect, it } from "vitest";
import { POLICE_PAGES, editionFrom, editionRoute } from "./edition";

describe("editions", () => {
  it("is the full product unless the police edition is asked for", () => {
    expect(editionFrom(undefined)).toBe("full");
    expect(editionFrom("Police")).toBe("full");
    expect(editionFrom("police")).toBe("police");
    expect(editionRoute("full", "/console/clients")).toBe("serve");
    expect(editionRoute("full", "/w/clinic/campaigns")).toBe("serve");
  });

  it("serves the complaint portal on a police server", () => {
    for (const page of POLICE_PAGES) expect(editionRoute("police", `/w/cy-police${page}`)).toBe("serve");
    for (const path of [
      "/w/cy-police/calls/2b1f0c4e-1111-4222-8333-944455556666",
      "/api/w/cy-police/calls/2b1f0c4e-1111-4222-8333-944455556666/recording",
      "/api/w/cy-police/complaints",
      "/api/w/cy-police/cases/2b1f0c4e-1111-4222-8333-944455556666/evidence/2b1f0c4e-1111-4222-8333-944455556667",
      "/print/cy-police/cases/2b1f0c4e-1111-4222-8333-944455556666",
      "/w/cy-police/cases/2b1f0c4e-1111-4222-8333-944455556666",
      "/api/whatsapp/openwa",
      "/print/cy-police/calls/2b1f0c4e-1111-4222-8333-944455556666",
      "/login",
      "/orgs",
      "/account/security",
      "/invite/abc",
      "/api/auth/sign-in/email",
      "/api/version",
      "/",
    ])
      expect(editionRoute("police", path), path).toBe("serve");
  });

  it("opens a workspace on its complaints", () => {
    expect(editionRoute("police", "/w/cy-police")).toEqual({ redirect: "/w/cy-police/analytics" });
    expect(editionRoute("police", "/w/cy-police/")).toEqual({ redirect: "/w/cy-police/analytics" });
  });

  it("does not serve anything outside the portal there", () => {
    for (const path of [
      "/console",
      "/console/clients/new",
      "/api/v1/calls",
      "/api/v1/recordings/2b1f0c4e-1111-4222-8333-944455556666",
      "/w/cy-police/leads",
      "/w/cy-police/campaigns",
      "/w/cy-police/integrations",
      "/w/cy-police/plan",
      "/w/cy-police/settings",
      "/w/cy-police/agents",
      "/w/cy-police/calls%2F..%2Fcampaigns",
      "/api/w/cy-police/leads",
      "/api/w/cy-police",
    ])
      expect(editionRoute("police", path), path).toBe("not_found");
  });
});
