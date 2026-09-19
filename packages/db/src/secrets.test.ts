import "./scripts/env";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./secrets";

describe("tenant-bound secrets", () => {
  it("round-trips for the same tenant and purpose", () => {
    const s = sealSecret("t1", "voice", "api-key-123");
    expect(s.startsWith("v1:")).toBe(true);
    expect(s).not.toContain("api-key-123");
    expect(openSecret("t1", "voice", s)).toBe("api-key-123");
  });
  it("refuses another tenant or purpose", () => {
    const s = sealSecret("t1", "voice", "api-key-123");
    expect(() => openSecret("t2", "voice", s)).toThrow();
    expect(() => openSecret("t1", "carrier", s)).toThrow();
  });
});
