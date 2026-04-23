import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let redisClientRef: any;
const pipelineCalls: Array<unknown[]> = [];

const makePipeline = (getResult: unknown) => {
  const pipeline = {
    get: vi.fn((...args: unknown[]) => {
      pipelineCalls.push(["get", ...args]);
      return pipeline;
    }),
    expire: vi.fn((...args: unknown[]) => {
      pipelineCalls.push(["expire", ...args]);
      return pipeline;
    }),
    exec: vi.fn(async () => {
      pipelineCalls.push(["exec"]);
      // ioredis pipeline.exec() returns [[err, value], ...] per command
      return [[null, getResult]];
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

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => redisClientRef,
}));

describe("UserAffinity Redis helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    pipelineCalls.length = 0;
    redisClientRef = {
      status: "ready",
      setex: vi.fn(async () => "OK"),
      del: vi.fn(async () => 1),
      pipeline: vi.fn(() => makePipeline("42")),
    };
  });

  afterEach(() => {
    delete process.env.USER_AFFINITY_TTL;
  });

  describe("getUserAffinity", () => {
    it("returns null when Redis is not ready", async () => {
      redisClientRef.status = "connecting";
      const mod = await import("@/lib/redis/user-affinity");

      const result = await mod.getUserAffinity(7, "default");

      expect(result).toBeNull();
      expect(redisClientRef.pipeline).not.toHaveBeenCalled();
    });

    it("returns providerId and refreshes TTL on hit", async () => {
      const mod = await import("@/lib/redis/user-affinity");

      const result = await mod.getUserAffinity(7, "default");

      expect(result).toBe(42);
      const getCall = pipelineCalls.find((c) => c[0] === "get");
      const expireCall = pipelineCalls.find((c) => c[0] === "expire");
      expect(getCall?.[1]).toBe("affinity:user:7:group:default");
      expect(expireCall?.[1]).toBe("affinity:user:7:group:default");
      // default 7d = 604800s
      expect(Number(expireCall?.[2])).toBe(7 * 24 * 60 * 60);
    });

    it("returns null when key is missing", async () => {
      redisClientRef.pipeline = vi.fn(() => makePipeline(null));
      const mod = await import("@/lib/redis/user-affinity");

      const result = await mod.getUserAffinity(7, "default");

      expect(result).toBeNull();
    });

    it("returns null when stored value is malformed", async () => {
      redisClientRef.pipeline = vi.fn(() => makePipeline("not-a-number"));
      const mod = await import("@/lib/redis/user-affinity");

      const result = await mod.getUserAffinity(7, "default");

      expect(result).toBeNull();
    });

    it("returns null when Redis throws", async () => {
      redisClientRef.pipeline = vi.fn(() => {
        throw new Error("redis down");
      });
      const mod = await import("@/lib/redis/user-affinity");

      const result = await mod.getUserAffinity(7, "default");

      expect(result).toBeNull();
    });
  });

  describe("setUserAffinity", () => {
    it("is a no-op when Redis is not ready", async () => {
      redisClientRef.status = "end";
      const mod = await import("@/lib/redis/user-affinity");

      await mod.setUserAffinity(7, "default", 42);

      expect(redisClientRef.setex).not.toHaveBeenCalled();
    });

    it("writes SETEX with providerId and default 7d TTL", async () => {
      const mod = await import("@/lib/redis/user-affinity");

      await mod.setUserAffinity(7, "default", 42);

      expect(redisClientRef.setex).toHaveBeenCalledWith(
        "affinity:user:7:group:default",
        7 * 24 * 60 * 60,
        "42"
      );
    });

    it("honors USER_AFFINITY_TTL env override", async () => {
      process.env.USER_AFFINITY_TTL = "3600";
      const mod = await import("@/lib/redis/user-affinity");

      await mod.setUserAffinity(7, "cli", 99);

      expect(redisClientRef.setex).toHaveBeenCalledWith("affinity:user:7:group:cli", 3600, "99");
    });
  });

  describe("clearUserAffinity", () => {
    it("calls DEL on the correct key", async () => {
      const mod = await import("@/lib/redis/user-affinity");

      await mod.clearUserAffinity(7, "default");

      expect(redisClientRef.del).toHaveBeenCalledWith("affinity:user:7:group:default");
    });

    it("is a no-op when Redis is not ready", async () => {
      redisClientRef.status = "connecting";
      const mod = await import("@/lib/redis/user-affinity");

      await mod.clearUserAffinity(7, "default");

      expect(redisClientRef.del).not.toHaveBeenCalled();
    });
  });
});
