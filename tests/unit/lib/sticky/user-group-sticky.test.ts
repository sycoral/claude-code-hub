import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track the most recent pipeline created so individual tests can inspect it.
let lastPipeline: ReturnType<typeof makePipeline> | null = null;

const makePipeline = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  let execReturn: Array<[Error | null, unknown]> = [];

  const pipeline = {
    calls,
    setExecReturn(value: Array<[Error | null, unknown]>) {
      execReturn = value;
    },
    set: vi.fn((...args: unknown[]) => {
      calls.push(["set", ...args]);
      return pipeline;
    }),
    zadd: vi.fn((...args: unknown[]) => {
      calls.push(["zadd", ...args]);
      return pipeline;
    }),
    zrem: vi.fn((...args: unknown[]) => {
      calls.push(["zrem", ...args]);
      return pipeline;
    }),
    expire: vi.fn((...args: unknown[]) => {
      calls.push(["expire", ...args]);
      return pipeline;
    }),
    del: vi.fn((...args: unknown[]) => {
      calls.push(["del", ...args]);
      return pipeline;
    }),
    zremrangebyscore: vi.fn((...args: unknown[]) => {
      calls.push(["zremrangebyscore", ...args]);
      return pipeline;
    }),
    zcard: vi.fn((...args: unknown[]) => {
      calls.push(["zcard", ...args]);
      return pipeline;
    }),
    exec: vi.fn(async () => {
      calls.push(["exec"]);
      return execReturn;
    }),
  };
  return pipeline;
};

let redisClientRef: {
  status: string;
  get: ReturnType<typeof vi.fn>;
  zscore: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
} | null = null;

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

const NOW_MS = 1_700_000_000_000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
  lastPipeline = null;

  redisClientRef = {
    status: "ready",
    get: vi.fn(),
    zscore: vi.fn(),
    pipeline: vi.fn(() => {
      const p = makePipeline();
      lastPipeline = p;
      // Default: 2 successful results so callers expecting [err, value] tuples
      // don't crash. Tests override via setExecReturn() when they care.
      p.setExecReturn([
        [null, "OK"],
        [null, 1],
      ]);
      return p;
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("user-group-sticky", () => {
  // ---------- getStickyProvider ----------

  describe("getStickyProvider", () => {
    it("returns providerId when binding exists", async () => {
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.get.mockResolvedValueOnce("42");

      const result = await getStickyProvider(7, "team-a");

      expect(redisClientRef!.get).toHaveBeenCalledWith("user:7:group:team-a:provider");
      expect(result).toBe(42);
    });

    it("returns null when no binding exists", async () => {
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.get.mockResolvedValueOnce(null);

      expect(await getStickyProvider(7, "team-a")).toBeNull();
    });

    it("returns null when stored value is not a number", async () => {
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.get.mockResolvedValueOnce("not-a-number");

      expect(await getStickyProvider(7, "team-a")).toBeNull();
    });

    it("returns null when redis is not ready", async () => {
      redisClientRef = { ...redisClientRef!, status: "connecting" };
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");

      expect(await getStickyProvider(7, "team-a")).toBeNull();
    });

    it("returns null when redis is null", async () => {
      redisClientRef = null;
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");

      expect(await getStickyProvider(7, "team-a")).toBeNull();
    });

    it("returns null on redis throw", async () => {
      const { getStickyProvider } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.get.mockRejectedValueOnce(new Error("boom"));

      expect(await getStickyProvider(7, "team-a")).toBeNull();
    });
  });

  // ---------- bindSticky ----------

  describe("bindSticky", () => {
    it("writes both the user binding and the provider ZSet entry", async () => {
      const { bindSticky } = await import("@/lib/sticky/user-group-sticky");

      const ok = await bindSticky(7, "team-a", 42, 3600);

      expect(ok).toBe(true);
      expect(lastPipeline!.set).toHaveBeenCalledWith(
        "user:7:group:team-a:provider",
        "42",
        "EX",
        3600
      );
      expect(lastPipeline!.zadd).toHaveBeenCalledWith(
        "provider:42:group:team-a:active_users",
        NOW_MS + 3600 * 1000,
        "7"
      );
    });

    it("returns false when redis is not ready", async () => {
      redisClientRef = { ...redisClientRef!, status: "end" };
      const { bindSticky } = await import("@/lib/sticky/user-group-sticky");

      expect(await bindSticky(7, "team-a", 42, 3600)).toBe(false);
    });

    it("returns false when ttl is non-positive", async () => {
      const { bindSticky } = await import("@/lib/sticky/user-group-sticky");

      expect(await bindSticky(7, "team-a", 42, 0)).toBe(false);
      expect(await bindSticky(7, "team-a", 42, -1)).toBe(false);
      expect(redisClientRef!.pipeline).not.toHaveBeenCalled();
    });

    it("returns false when pipeline reports an error", async () => {
      const { bindSticky } = await import("@/lib/sticky/user-group-sticky");
      // Override pipeline to return an error on the SET command.
      redisClientRef!.pipeline.mockImplementationOnce(() => {
        const p = makePipeline();
        lastPipeline = p;
        p.setExecReturn([[new Error("pipeline error"), null]]);
        return p;
      });

      expect(await bindSticky(7, "team-a", 42, 3600)).toBe(false);
    });
  });

  // ---------- refreshStickyTTL ----------

  describe("refreshStickyTTL", () => {
    it("extends user-key TTL and ZADD GT to raise score", async () => {
      const { refreshStickyTTL } = await import("@/lib/sticky/user-group-sticky");

      await refreshStickyTTL(7, "team-a", 42, 3600);

      expect(lastPipeline!.expire).toHaveBeenCalledWith("user:7:group:team-a:provider", 3600);
      expect(lastPipeline!.zadd).toHaveBeenCalledWith(
        "provider:42:group:team-a:active_users",
        "GT",
        NOW_MS + 3600 * 1000,
        "7"
      );
    });

    it("no-ops when redis is not ready", async () => {
      redisClientRef = { ...redisClientRef!, status: "wait" };
      const { refreshStickyTTL } = await import("@/lib/sticky/user-group-sticky");

      await refreshStickyTTL(7, "team-a", 42, 3600);
      expect(redisClientRef!.pipeline).not.toHaveBeenCalled();
    });

    it("no-ops when ttl is non-positive", async () => {
      const { refreshStickyTTL } = await import("@/lib/sticky/user-group-sticky");

      await refreshStickyTTL(7, "team-a", 42, 0);
      expect(redisClientRef!.pipeline).not.toHaveBeenCalled();
    });
  });

  // ---------- clearSticky ----------

  describe("clearSticky", () => {
    it("deletes the user key and removes ZSet entry when providerId is given", async () => {
      const { clearSticky } = await import("@/lib/sticky/user-group-sticky");

      await clearSticky(7, "team-a", 42);

      expect(lastPipeline!.del).toHaveBeenCalledWith("user:7:group:team-a:provider");
      expect(lastPipeline!.zrem).toHaveBeenCalledWith("provider:42:group:team-a:active_users", "7");
    });

    it("only deletes the user key when providerId is omitted", async () => {
      const { clearSticky } = await import("@/lib/sticky/user-group-sticky");

      await clearSticky(7, "team-a");

      expect(lastPipeline!.del).toHaveBeenCalledWith("user:7:group:team-a:provider");
      expect(lastPipeline!.zrem).not.toHaveBeenCalled();
    });

    it("no-ops when redis is not ready", async () => {
      redisClientRef = null;
      const { clearSticky } = await import("@/lib/sticky/user-group-sticky");

      // Should not throw.
      await clearSticky(7, "team-a", 42);
    });
  });

  // ---------- countActiveUsers ----------

  describe("countActiveUsers", () => {
    it("prunes expired entries then returns ZCARD", async () => {
      const { countActiveUsers } = await import("@/lib/sticky/user-group-sticky");

      // Override exec to return [zremrangebyscore_result, zcard_result].
      redisClientRef!.pipeline.mockImplementationOnce(() => {
        const p = makePipeline();
        lastPipeline = p;
        p.setExecReturn([
          [null, 0], // zremrangebyscore removed 0 expired entries
          [null, 5], // zcard = 5 active users
        ]);
        return p;
      });

      const count = await countActiveUsers(42, "team-a");

      expect(count).toBe(5);
      expect(lastPipeline!.zremrangebyscore).toHaveBeenCalledWith(
        "provider:42:group:team-a:active_users",
        0,
        NOW_MS
      );
      expect(lastPipeline!.zcard).toHaveBeenCalledWith("provider:42:group:team-a:active_users");
    });

    it("returns 0 when redis is not ready", async () => {
      redisClientRef = null;
      const { countActiveUsers } = await import("@/lib/sticky/user-group-sticky");

      expect(await countActiveUsers(42, "team-a")).toBe(0);
    });

    it("returns 0 when zcard reports an error", async () => {
      const { countActiveUsers } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.pipeline.mockImplementationOnce(() => {
        const p = makePipeline();
        lastPipeline = p;
        p.setExecReturn([
          [null, 0],
          [new Error("zcard fail"), null],
        ]);
        return p;
      });

      expect(await countActiveUsers(42, "team-a")).toBe(0);
    });
  });

  // ---------- isUserCountedOn ----------

  describe("isUserCountedOn", () => {
    it("returns true when ZSCORE is in the future", async () => {
      const { isUserCountedOn } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.zscore.mockResolvedValueOnce(String(NOW_MS + 1000));

      expect(await isUserCountedOn(42, "team-a", 7)).toBe(true);
      expect(redisClientRef!.zscore).toHaveBeenCalledWith(
        "provider:42:group:team-a:active_users",
        "7"
      );
    });

    it("returns false when ZSCORE is in the past (expired)", async () => {
      const { isUserCountedOn } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.zscore.mockResolvedValueOnce(String(NOW_MS - 1000));

      expect(await isUserCountedOn(42, "team-a", 7)).toBe(false);
    });

    it("returns false when user is not in the ZSet", async () => {
      const { isUserCountedOn } = await import("@/lib/sticky/user-group-sticky");
      redisClientRef!.zscore.mockResolvedValueOnce(null);

      expect(await isUserCountedOn(42, "team-a", 7)).toBe(false);
    });

    it("returns false when redis is not ready", async () => {
      redisClientRef = null;
      const { isUserCountedOn } = await import("@/lib/sticky/user-group-sticky");

      expect(await isUserCountedOn(42, "team-a", 7)).toBe(false);
    });
  });
});
