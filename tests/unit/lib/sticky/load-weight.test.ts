import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindWeeklyGroupScopedUsage = vi.fn();
const mockCountEnabledProvidersInGroup = vi.fn();

vi.mock("@/repository/leaderboard", () => ({
  findWeeklyGroupScopedUsage: mockFindWeeklyGroupScopedUsage,
}));

vi.mock("@/repository/provider-groups", () => ({
  countEnabledProvidersInGroup: mockCountEnabledProvidersInGroup,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  mockCountEnabledProvidersInGroup.mockResolvedValue(5); // sensible default
  const { clearLoadWeightCache } = await import("@/lib/sticky/load-weight");
  clearLoadWeightCache();
});

afterEach(() => {
  vi.useRealTimers();
});

const entry = (userId: number, totalTokens: number) => ({
  userId,
  totalTokens,
});

describe("load-weight", () => {
  describe("deriveWeightTiers (pure)", () => {
    it("returns N and ceil(N/2) for normal account counts", async () => {
      const { deriveWeightTiers } = await import("@/lib/sticky/load-weight");
      expect(deriveWeightTiers(5)).toEqual({ heavyWeight: 5, mediumWeight: 3 });
      expect(deriveWeightTiers(4)).toEqual({ heavyWeight: 4, mediumWeight: 2 });
      expect(deriveWeightTiers(3)).toEqual({ heavyWeight: 3, mediumWeight: 2 });
      expect(deriveWeightTiers(2)).toEqual({ heavyWeight: 2, mediumWeight: 1 });
      expect(deriveWeightTiers(1)).toEqual({ heavyWeight: 1, mediumWeight: 1 });
    });

    it("falls back to 3/2 when N=0 (no enabled providers)", async () => {
      const { deriveWeightTiers } = await import("@/lib/sticky/load-weight");
      expect(deriveWeightTiers(0)).toEqual({ heavyWeight: 3, mediumWeight: 2 });
    });
  });

  describe("classifyLoadTier (pure)", () => {
    it("classifies by threshold in normal cases (N>=3)", async () => {
      const { classifyLoadTier } = await import("@/lib/sticky/load-weight");
      const t = { heavyWeight: 5, mediumWeight: 3 };
      expect(classifyLoadTier(5, t)).toBe("heavy");
      expect(classifyLoadTier(3, t)).toBe("medium");
      expect(classifyLoadTier(1, t)).toBe("normal");
    });

    it("collapses medium into normal when mediumWeight=NORMAL_WEIGHT (N=2 case)", async () => {
      const { classifyLoadTier } = await import("@/lib/sticky/load-weight");
      const t = { heavyWeight: 2, mediumWeight: 1 };
      expect(classifyLoadTier(2, t)).toBe("heavy");
      expect(classifyLoadTier(1, t)).toBe("normal"); // would be medium if not collapsed
    });

    it("collapses everything into normal when heavyWeight=NORMAL_WEIGHT (N=1 case)", async () => {
      const { classifyLoadTier } = await import("@/lib/sticky/load-weight");
      const t = { heavyWeight: 1, mediumWeight: 1 };
      expect(classifyLoadTier(1, t)).toBe("normal");
    });
  });

  describe("getUserLoadWeights", () => {
    it("buckets users by rank using N=providerCount (top N=heavy, next N=medium, rest=normal)", async () => {
      // N=5 → top 5 heavy (weight 5), next 5 medium (weight ceil(5/2)=3), rest normal (1)
      mockCountEnabledProvidersInGroup.mockResolvedValueOnce(5);
      const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, (20 - i) * 1_000_000));
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce(entries);

      const { getUserLoadWeights, NORMAL_WEIGHT } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("team-a");

      // ranks 1..5 → heavy = 5
      expect(weights.get(1)).toBe(5);
      expect(weights.get(5)).toBe(5);
      // ranks 6..10 → medium = 3
      expect(weights.get(6)).toBe(3);
      expect(weights.get(10)).toBe(3);
      // ranks 11..20 → normal = 1
      expect(weights.get(11)).toBe(NORMAL_WEIGHT);
      expect(weights.get(20)).toBe(NORMAL_WEIGHT);
    });

    it("filters out users with zero totalTokens", async () => {
      const entries = [entry(1, 1_000), entry(2, 0), entry(3, 0)];
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce(entries);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("team-a");

      expect(weights.has(1)).toBe(true);
      expect(weights.has(2)).toBe(false);
      expect(weights.has(3)).toBe(false);
    });

    it("returns empty map when leaderboard is empty", async () => {
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce([]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("team-a");
      expect(weights.size).toBe(0);
    });

    it("when N=0, falls back to legacy 5%/20% percentiles + fallback weights", async () => {
      mockCountEnabledProvidersInGroup.mockResolvedValueOnce(0);
      // 20 users → ceil(20*0.05)=1 heavy(=3), ceil(20*0.2)=4 → 3 more medium(=2), rest normal(=1)
      const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, (20 - i) * 1_000_000));
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce(entries);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("orphan-group");

      expect(weights.get(1)).toBe(3); // heavy fallback
      expect(weights.get(2)).toBe(2); // medium fallback
      expect(weights.get(4)).toBe(2);
      expect(weights.get(5)).toBe(1); // normal
    });

    it("caches results for 5 minutes (does not re-query within window)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1));

      mockCountEnabledProvidersInGroup.mockResolvedValue(3);
      mockFindWeeklyGroupScopedUsage.mockResolvedValue([entry(1, 1000)]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");

      await getUserLoadWeights("team-a");
      await getUserLoadWeights("team-a");
      await getUserLoadWeights("team-a");

      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4 * 60 * 1000);
      await getUserLoadWeights("team-a");
      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2 * 60 * 1000);
      await getUserLoadWeights("team-a");
      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(2);
    });

    it("returns empty map and caches it on leaderboard error (graceful fallback)", async () => {
      mockFindWeeklyGroupScopedUsage.mockRejectedValueOnce(new Error("boom"));

      const { getUserLoadWeights, NORMAL_WEIGHT } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("team-a");

      expect(weights.size).toBe(0);
      expect(NORMAL_WEIGHT).toBe(1);
    });

    it("dedupes concurrent in-flight calls into one fetch", async () => {
      let resolveFn!: (v: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        resolveFn = resolve;
      });
      mockFindWeeklyGroupScopedUsage.mockReturnValueOnce(pending);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const p1 = getUserLoadWeights("team-a");
      const p2 = getUserLoadWeights("team-a");
      const p3 = getUserLoadWeights("team-a");

      resolveFn([entry(1, 1000)]);
      await Promise.all([p1, p2, p3]);

      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(1);
    });

    it("passes the group name to the group-scoped usage query", async () => {
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce([entry(1, 1000)]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      await getUserLoadWeights("team-a");

      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledWith("team-a");
    });

    it("caches per-group independently", async () => {
      mockCountEnabledProvidersInGroup.mockResolvedValueOnce(2).mockResolvedValueOnce(4);
      mockFindWeeklyGroupScopedUsage
        .mockResolvedValueOnce([entry(1, 9_000_000)])
        .mockResolvedValueOnce([entry(2, 9_000_000)]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");

      const a = await getUserLoadWeights("team-a");
      const b = await getUserLoadWeights("team-b");
      // team-a: N=2 → heavy=2
      expect(a.get(1)).toBe(2);
      // team-b: N=4 → heavy=4
      expect(b.get(2)).toBe(4);
      expect(a.has(2)).toBe(false);
      expect(b.has(1)).toBe(false);
      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(2);

      await getUserLoadWeights("team-a");
      await getUserLoadWeights("team-b");
      expect(mockFindWeeklyGroupScopedUsage).toHaveBeenCalledTimes(2);
    });

    it("returns empty map for empty group name", async () => {
      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights("");
      expect(weights.size).toBe(0);
      expect(mockFindWeeklyGroupScopedUsage).not.toHaveBeenCalled();
    });
  });

  describe("getUserLoadWeight (single-user lookup)", () => {
    it("returns NORMAL_WEIGHT for users not in the leaderboard", async () => {
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce([entry(1, 1000)]);

      const { getUserLoadWeight, NORMAL_WEIGHT } = await import("@/lib/sticky/load-weight");
      expect(await getUserLoadWeight(999, "team-a")).toBe(NORMAL_WEIGHT);
    });

    it("returns the bucketed weight for ranked users", async () => {
      mockCountEnabledProvidersInGroup.mockResolvedValueOnce(5);
      const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, (20 - i) * 1_000_000));
      mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce(entries);

      const { getUserLoadWeight } = await import("@/lib/sticky/load-weight");
      // user #1 is heaviest, N=5 → heavy weight = 5
      expect(await getUserLoadWeight(1, "team-a")).toBe(5);
    });
  });

  describe("getGroupWeightThresholds", () => {
    it("returns thresholds + providerCount for the group", async () => {
      mockCountEnabledProvidersInGroup.mockResolvedValueOnce(4);
      const { getGroupWeightThresholds } = await import("@/lib/sticky/load-weight");
      expect(await getGroupWeightThresholds("team-a")).toEqual({
        heavyWeight: 4,
        mediumWeight: 2,
        providerCount: 4,
      });
    });
  });
});
