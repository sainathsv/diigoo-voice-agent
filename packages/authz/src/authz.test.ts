import { describe, expect, it } from "vitest";
import { toLoginEmail, displayLogin, USERNAME_PATTERN } from "./login-id";
import {
  ALL_CLIENT_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  CLIENT_ROLE_TEMPLATES,
  PLATFORM_ROLE_TEMPLATES,
  branchesFor,
  can,
  findTemplate,
  isPermission,
  maskPhone,
  type AccessContext,
  type Grant,
} from "./index";

const role = (side: "client" | "platform", key: string) => {
  const t = findTemplate(side, key);
  if (!t) throw new Error(`no template ${key}`);
  return t.permissions;
};

const ctx = (grants: Grant[], extra: Partial<AccessContext> = {}): AccessContext => ({
  userId: "u1",
  orgId: "o1",
  orgKind: "client",
  grants,
  ...extra,
});

describe("role templates", () => {
  it("only reference permissions that exist", () => {
    for (const t of [...CLIENT_ROLE_TEMPLATES, ...PLATFORM_ROLE_TEMPLATES]) {
      for (const p of t.permissions) expect(isPermission(p), `${t.key}: ${p}`).toBe(true);
    }
  });
  it("keep platform and client permissions apart", () => {
    for (const t of CLIENT_ROLE_TEMPLATES) expect(t.permissions.some((p) => p.startsWith("platform:"))).toBe(false);
    for (const t of PLATFORM_ROLE_TEMPLATES) expect(t.permissions.every((p) => p.startsWith("platform:"))).toBe(true);
  });
  it("give the owner everything and nobody on the platform standing data access", () => {
    expect(role("client", "owner")).toEqual(ALL_CLIENT_PERMISSIONS);
    expect(role("platform", "super_admin")).toEqual(ALL_PLATFORM_PERMISSIONS);
    expect(ALL_PLATFORM_PERMISSIONS.some((p) => p.includes("calls") || p.includes("recordings"))).toBe(false);
  });
});

describe("can()", () => {
  const hyd = "branch-hyd";
  const vzg = "branch-vzg";
  const frontDesk: Grant = { roleKey: "front_desk", permissions: role("client", "front_desk"), scope: { type: "branch", branchId: hyd } };

  it("scopes branch roles to their branch", () => {
    const c = ctx([frontDesk]);
    expect(can(c, "calls:view", { branchId: hyd })).toBe(true);
    expect(can(c, "calls:view", { branchId: vzg })).toBe(false);
    expect(can(c, "calls:view")).toBe(false); // org-wide resource needs an org-scoped grant
    expect(branchesFor(c, "calls:view")).toEqual([hyd]);
  });

  it("unions multiple roles", () => {
    const c = ctx([frontDesk, { roleKey: "analyst", permissions: role("client", "analyst"), scope: { type: "org" } }]);
    expect(can(c, "calls:view", { branchId: vzg })).toBe(true);
    expect(branchesFor(c, "calls:view")).toBe("all");
    expect(can(c, "contacts:reveal_phone", { branchId: vzg })).toBe(false);
    expect(can(c, "contacts:reveal_phone", { branchId: hyd })).toBe(true);
  });

  it("ignores expired grants", () => {
    const now = new Date("2026-09-19T10:00:00Z");
    const expired: Grant = { ...frontDesk, expiresAt: new Date("2026-09-18T00:00:00Z") };
    expect(can(ctx([expired], { now }), "calls:view", { branchId: hyd })).toBe(false);
  });

  it("marketing cannot launch or see full numbers", () => {
    const c = ctx([{ roleKey: "marketing", permissions: role("client", "marketing"), scope: { type: "org" } }]);
    expect(can(c, "campaigns:create")).toBe(true);
    expect(can(c, "campaigns:launch")).toBe(false);
    expect(can(c, "contacts:reveal_phone")).toBe(false);
  });

  it("read-only support sessions never play recordings or reveal numbers", () => {
    const support = { staffUserId: "s1", grantId: "g1", mode: "read" as const, expiresAt: new Date(Date.now() + 60_000) };
    const c = ctx([], { support });
    expect(can(c, "calls:view")).toBe(true);
    expect(can(c, "recordings:play")).toBe(false);
    expect(can(c, "contacts:reveal_phone")).toBe(false);
    expect(can(c, "contacts:edit")).toBe(false);
  });

  it("write support sessions can fix things but never touch money, keys, numbers or exports", () => {
    const support = { staffUserId: "s1", grantId: "g1", mode: "write" as const, expiresAt: new Date(Date.now() + 60_000) };
    const c = ctx([], { support });
    expect(can(c, "agents:edit")).toBe(true);
    for (const p of ["billing:manage", "apikeys:manage", "numbers:manage", "contacts:export", "org:transfer_ownership"] as const) {
      expect(can(c, p)).toBe(false);
    }
  });

  it("expired support sessions grant nothing", () => {
    const support = { staffUserId: "s1", grantId: "g1", mode: "write" as const, expiresAt: new Date(Date.now() - 1) };
    expect(can(ctx([], { support }), "calls:view")).toBe(false);
  });
});

describe("maskPhone()", () => {
  it("keeps country code and last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ••••• •3210");
    expect(maskPhone("9876543210")).toBe("••••• •3210");
    expect(maskPhone("")).toBe("");
  });
});

describe("signing in with a username", () => {
  it("resolves a username to its account, whatever case it was typed in", () => {
    expect(toLoginEmail("CY_Police")).toBe("cy_police@id.jenai.local");
    expect(toLoginEmail("  cy_police  ")).toBe("cy_police@id.jenai.local");
  });

  it("leaves a real email alone", () => {
    expect(toLoginEmail("Owner@Zennara.com")).toBe("owner@zennara.com");
  });

  it("shows a username back as a username, and an email as an email", () => {
    expect(displayLogin("cy_police@id.jenai.local")).toBe("cy_police");
    expect(displayLogin("owner@zennara.com")).toBe("owner@zennara.com");
  });

  it("refuses usernames that would read ambiguously", () => {
    for (const bad of ["ab", "_leading", "has space", "a".repeat(41), "sneaky@thing"]) {
      expect(USERNAME_PATTERN.test(bad), bad).toBe(false);
    }
    for (const good of ["CY_Police", "front-desk", "ghmc.ward12", "zen1"]) {
      expect(USERNAME_PATTERN.test(good), good).toBe(true);
    }
  });
});
