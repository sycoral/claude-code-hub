import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLeaderboardWithCache = vi.fn();
const mockGetSystemSettings = vi.fn();

vi.mock("@/lib/redis/leaderboard-cache", () => ({
  getLeaderboardWithCache: mockGetLeaderboardWithCache,
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: mockGetSystemSettings,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  mockGetSystemSettings.mockResolvedValue({ currencyDisplay: "USD" });
  // Each test gets a fresh in-memory cache.
  const { clearLoadWeightCache } = await import("@/lib/sticky/load-weight");
  clearLoadWeightCache();
});

afterEach(() => {
  vi.useRealTimers();
});

const entry = (userId: number, totalTokens: number) => ({
  userId,
  userName: `u${userId}`,
  totalRequests: 1,
  totalCost: 0,
  totalTokens,
});

describe("load-weight", () => {
  describe("getUserLoadWeights", () => {
    it("buckets users by percentile (heavy / medium / normal)", async () => {
      // 20 users: top 5% = 1 heavy, top 5%-20% = 3 more medium, rest = 16 normal.
      const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, (20 - i) * 1_000_000));
      mockGetLeaderboardWithCache.mockResolvedValueOnce(entries);

      const { getUserLoadWeights, HEAVY_WEIGHT, MEDIUM_WEIGHT, NORMAL_WEIGHT } = await import(
        "@/lib/sticky/load-weight"
      );

      const weights = await getUserLoadWeights();

      // user 1 is the heaviest
      expect(weights.get(1)).toBe(HEAVY_WEIGHT);
      // users 2..4 are medium
      expect(weights.get(2)).toBe(MEDIUM_WEIGHT);
      expect(weights.get(3)).toBe(MEDIUM_WEIGHT);
      expect(weights.get(4)).toBe(MEDIUM_WEIGHT);
      // users 5..20 are normal
      expect(weights.get(5)).toBe(NORMAL_WEIGHT);
      expect(weights.get(20)).toBe(NORMAL_WEIGHT);
    });

    it("uses ceil so small populations still get a non-empty heavy bucket", async () => {
      // 3 users: ceil(3*0.05) = 1 heavy, ceil(3*0.20) = 1 medium total → 1 heavy + 0 extra medium + 2 normal.
      // Actually heavyCount=1, mediumCount=ceil(0.6)=1, so positions [0,1) heavy, [1,1) medium (empty), rest normal.
      const entries = [entry(1, 9_000_000), entry(2, 5_000_000), entry(3, 1_000_000)];
      mockGetLeaderboardWithCache.mockResolvedValueOnce(entries);

      const { getUserLoadWeights, HEAVY_WEIGHT, NORMAL_WEIGHT } = await import(
        "@/lib/sticky/load-weight"
      );

      const weights = await getUserLoadWeights();
      expect(weights.get(1)).toBe(HEAVY_WEIGHT);
      expect(weights.get(2)).toBe(NORMAL_WEIGHT); // medium bucket is empty in this size
      expect(weights.get(3)).toBe(NORMAL_WEIGHT);
    });

    it("filters out users with zero totalTokens", async () => {
      const entries = [entry(1, 1_000), entry(2, 0), entry(3, 0)];
      mockGetLeaderboardWithCache.mockResolvedValueOnce(entries);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights();

      expect(weights.has(1)).toBe(true);
      expect(weights.has(2)).toBe(false);
      expect(weights.has(3)).toBe(false);
    });

    it("returns empty map when leaderboard is empty", async () => {
      mockGetLeaderboardWithCache.mockResolvedValueOnce([]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights();
      expect(weights.size).toBe(0);
    });

    it("caches results for 5 minutes (does not re-query within window)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1));

      mockGetLeaderboardWithCache.mockResolvedValue([entry(1, 1000)]);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");

      await getUserLoadWeights();
      await getUserLoadWeights();
      await getUserLoadWeights();

      expect(mockGetLeaderboardWithCache).toHaveBeenCalledTimes(1);

      // Advance 4 minutes — still cached
      vi.advanceTimersByTime(4 * 60 * 1000);
      await getUserLoadWeights();
      expect(mockGetLeaderboardWithCache).toHaveBeenCalledTimes(1);

      // Advance another 2 minutes (total 6) — cache expired, re-query
      vi.advanceTimersByTime(2 * 60 * 1000);
      await getUserLoadWeights();
      expect(mockGetLeaderboardWithCache).toHaveBeenCalledTimes(2);
    });

    it("returns empty map and caches it on leaderboard error (graceful fallback)", async () => {
      mockGetLeaderboardWithCache.mockRejectedValueOnce(new Error("boom"));

      const { getUserLoadWeights, NORMAL_WEIGHT } = await import("@/lib/sticky/load-weight");
      const weights = await getUserLoadWeights();

      expect(weights.size).toBe(0);
      // Caller can still safely call getUserLoadWeight; default is NORMAL_WEIGHT
      expect(NORMAL_WEIGHT).toBe(1);
    });

    it("dedupes concurrent in-flight calls into one fetch", async () => {
      let resolveFn!: (v: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        resolveFn = resolve;
      });
      mockGetLeaderboardWithCache.mockReturnValueOnce(pending);

      const { getUserLoadWeights } = await import("@/lib/sticky/load-weight");
      const p1 = getUserLoadWeights();
      const p2 = getUserLoadWeights();
      const p3 = getUserLoadWeights();

      resolveFn([entry(1, 1000)]);
      await Promise.all([p1, p2, p3]);

      expect(mockGetLeaderboardWithCache).toHaveBeenCalledTimes(1);
    });
  });

  describe("getUserLoadWeight (single-user lookup)", () => {
    it("returns NORMAL_WEIGHT for users not in the leaderboard", async () => {
      mockGetLeaderboardWithCache.mockResolvedValueOnce([entry(1, 1000)]);

      const { getUserLoadWeight, NORMAL_WEIGHT } = await import("@/lib/sticky/load-weight");
      expect(await getUserLoadWeight(999)).toBe(NORMAL_WEIGHT);
    });

    it("returns the bucketed weight for ranked users", async () => {
      const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, (20 - i) * 1_000_000));
      mockGetLeaderboardWithCache.mockResolvedValueOnce(entries);

      const { getUserLoadWeight, HEAVY_WEIGHT } = await import("@/lib/sticky/load-weight");
      expect(await getUserLoadWeight(1)).toBe(HEAVY_WEIGHT);
    });
  });
});
