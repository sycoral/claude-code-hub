import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let redisClientRef: any;
const pipelineCalls: Array<unknown[]> = [];

const makePipeline = () => {
  const pipeline = {
    zadd: vi.fn((...args: unknown[]) => {
      pipelineCalls.push(["zadd", ...args]);
      return pipeline;
    }),
    expire: vi.fn((...args: unknown[]) => {
      pipelineCalls.push(["expire", ...args]);
      return pipeline;
    }),
    exec: vi.fn(async () => {
      pipelineCalls.push(["exec"]);
      return [];
    }),
  };
  return pipeline;
};

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClientRef,
}));

const statisticsMock = {
  sumKeyTotalCost: vi.fn(async () => 0),
  sumProviderTotalCost: vi.fn(async () => 0),
  sumUserTotalCost: vi.fn(async () => 0),
  sumUserCostInTimeRange: vi.fn(async () => 0),
  findKeyCostEntriesInTimeRange: vi.fn(async () => []),
  findProviderCostEntriesInTimeRange: vi.fn(async () => []),
  findUserCostEntriesInTimeRange: vi.fn(async () => []),
  sumKeyCostInTimeRange: vi.fn(async () => 0),
  sumProviderCostInTimeRange: vi.fn(async () => 0),
};
vi.mock("@/repository/statistics", () => statisticsMock);

describe("RateLimitService: provider user-slot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    pipelineCalls.length = 0;
    redisClientRef = {
      status: "ready",
      eval: vi.fn(),
      pipeline: vi.fn(() => makePipeline()),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkAndAcquireProviderUserSlot", () => {
    it("returns allowed without touching Redis when limit is 0", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 0);

      expect(result).toEqual({ allowed: true, count: 0, tracked: false });
      expect(redisClientRef.eval).not.toHaveBeenCalled();
    });

    it("fails open when Redis is not ready", async () => {
      redisClientRef.status = "connecting";
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 3);

      expect(result).toEqual({ allowed: true, count: 0, tracked: false });
      expect(redisClientRef.eval).not.toHaveBeenCalled();
    });

    it("calls the lua script with correct key/argv and reports a fresh tracking", async () => {
      redisClientRef.eval.mockResolvedValue([1, 1, 1]);
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 3);

      expect(result.allowed).toBe(true);
      expect(result.tracked).toBe(true);
      expect(result.count).toBe(1);
      expect(redisClientRef.eval).toHaveBeenCalledTimes(1);
      const [, numKeys, key, userId, limit, now, ttlMs] = redisClientRef.eval.mock.calls[0];
      expect(numKeys).toBe(1);
      expect(key).toBe("provider:42:active_users");
      expect(userId).toBe("7");
      expect(limit).toBe("3");
      // SESSION_TTL default = 600s = 600000ms after PR1
      expect(ttlMs).toBe("600000");
      // now is a numeric-string timestamp
      expect(Number.parseInt(now, 10)).toBeGreaterThan(0);
    });

    it("reports idempotent refresh when user already holds the slot", async () => {
      redisClientRef.eval.mockResolvedValue([1, 2, 0]);
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 3);

      expect(result).toEqual({ allowed: true, count: 2, tracked: false });
    });

    it("rejects with reason when slot is full", async () => {
      redisClientRef.eval.mockResolvedValue([0, 3, 0]);
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 3);

      expect(result.allowed).toBe(false);
      expect(result.count).toBe(3);
      expect(result.tracked).toBe(false);
      expect(result.reason).toContain("3/3");
    });

    it("fails open when lua evaluation throws", async () => {
      redisClientRef.eval.mockRejectedValue(new Error("redis down"));
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      const result = await RateLimitService.checkAndAcquireProviderUserSlot(42, 7, 3);

      expect(result).toEqual({ allowed: true, count: 0, tracked: false });
    });
  });

  describe("refreshProviderUserSlot", () => {
    it("silently no-ops when Redis is not ready", async () => {
      redisClientRef.status = "end";
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      await RateLimitService.refreshProviderUserSlot(42, 7);

      expect(redisClientRef.pipeline).not.toHaveBeenCalled();
    });

    it("refreshes ZSET score and expiry with a 3600s floor", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit/service");

      await RateLimitService.refreshProviderUserSlot(42, 7);

      const zaddCall = pipelineCalls.find((c) => c[0] === "zadd");
      const expireCall = pipelineCalls.find((c) => c[0] === "expire");
      expect(zaddCall?.[1]).toBe("provider:42:active_users");
      expect(zaddCall?.[3]).toBe("7");
      expect(expireCall?.[1]).toBe("provider:42:active_users");
      // TTL must be at least 3600 (ZSET integrity floor) even when SESSION_TTL is smaller
      expect(Number(expireCall?.[2])).toBeGreaterThanOrEqual(3600);
    });
  });
});
