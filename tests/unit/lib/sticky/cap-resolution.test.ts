import { describe, expect, it } from "vitest";
import { resolveEffectiveProviderCap } from "@/lib/sticky/cap-resolution";

describe("resolveEffectiveProviderCap", () => {
  it("uses per-provider override when set, ignoring the group default", () => {
    expect(resolveEffectiveProviderCap({ maxActiveUsersOverride: 3 }, 10)).toBe(3);
    expect(resolveEffectiveProviderCap({ maxActiveUsersOverride: 7 }, null)).toBe(7);
  });

  it("falls back to the group default when override is null", () => {
    expect(resolveEffectiveProviderCap({ maxActiveUsersOverride: null }, 10)).toBe(10);
  });

  it("returns null (unbounded) when override and group default are both null", () => {
    expect(resolveEffectiveProviderCap({ maxActiveUsersOverride: null }, null)).toBeNull();
  });
});
