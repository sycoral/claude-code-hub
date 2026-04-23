import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureMock = vi.hoisted(() => vi.fn<() => Promise<Response | null>>());
const getEffectiveProviderGroupMock = vi.hoisted(() => vi.fn(() => "default"));

let redisClientRef: any;

const makeRedisPipeline = () => {
  const pipeline = {
    rpush: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => []),
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

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: { ensure: ensureMock },
  getEffectiveProviderGroup: getEffectiveProviderGroupMock,
}));

// Short timings for the unit test so we do not actually wait 30s.
process.env.QUEUE_WAIT_TIMEOUT = "1"; // 1s
process.env.QUEUE_POLL_INTERVAL = "1"; // 1s (so 1 retry fits in 1s timeout)

const fakeSession = { sessionId: "sess-1", authState: { user: { id: 7 } } } as any;

function errorResponse(status: number, body = "{}") {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("ProxyQueuedProviderResolver.ensure", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    redisClientRef = {
      status: "ready",
      pipeline: vi.fn(() => makeRedisPipeline()),
      lrem: vi.fn(async () => 1),
    };
    getEffectiveProviderGroupMock.mockReturnValue("default");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null immediately when ensure succeeds on first try", async () => {
    ensureMock.mockResolvedValueOnce(null);
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const result = await ProxyQueuedProviderResolver.ensure(fakeSession);

    expect(result).toBeNull();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(redisClientRef.pipeline).not.toHaveBeenCalled();
  });

  it("returns non-503 response immediately without queueing", async () => {
    const resp = errorResponse(401, '{"error":"auth"}');
    ensureMock.mockResolvedValueOnce(resp);
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const result = await ProxyQueuedProviderResolver.ensure(fakeSession);

    expect(result?.status).toBe(401);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(redisClientRef.pipeline).not.toHaveBeenCalled();
  });

  it("queues on 503 and resolves when ensure succeeds during poll", async () => {
    ensureMock
      .mockResolvedValueOnce(errorResponse(503, '{"error":"full"}'))
      .mockResolvedValueOnce(null);
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const promise = ProxyQueuedProviderResolver.ensure(fakeSession);
    await vi.advanceTimersByTimeAsync(1500); // past one poll interval

    const result = await promise;

    expect(result).toBeNull();
    expect(ensureMock).toHaveBeenCalledTimes(2);
    // entered queue
    expect(redisClientRef.pipeline).toHaveBeenCalled();
    // exited queue
    expect(redisClientRef.lrem).toHaveBeenCalled();
  });

  it("returns 503 with Retry-After on timeout", async () => {
    ensureMock.mockResolvedValue(errorResponse(503, '{"error":"all providers unavailable"}'));
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const promise = ProxyQueuedProviderResolver.ensure(fakeSession);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;

    expect(result?.status).toBe(503);
    expect(result?.headers.get("Retry-After")).toBe("1");
    // queue popped even on timeout
    expect(redisClientRef.lrem).toHaveBeenCalled();
  });

  it("bails out of queue if ensure returns non-503 during polling", async () => {
    ensureMock
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(500, '{"error":"upstream"}'));
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const promise = ProxyQueuedProviderResolver.ensure(fakeSession);
    await vi.advanceTimersByTimeAsync(1500);

    const result = await promise;

    expect(result?.status).toBe(500);
    expect(ensureMock).toHaveBeenCalledTimes(2);
  });

  it("still polls when Redis is unavailable (fail open for queuing)", async () => {
    redisClientRef = null; // getRedisClient() returns null
    ensureMock.mockResolvedValueOnce(errorResponse(503)).mockResolvedValueOnce(null);
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const promise = ProxyQueuedProviderResolver.ensure(fakeSession);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toBeNull();
    expect(ensureMock).toHaveBeenCalledTimes(2);
  });

  it("uses 'default' as queue group when session has no effective group", async () => {
    getEffectiveProviderGroupMock.mockReturnValue(null);
    ensureMock.mockResolvedValueOnce(errorResponse(503)).mockResolvedValueOnce(null);
    const { ProxyQueuedProviderResolver } = await import("@/app/v1/_lib/proxy/queue-handler");

    const promise = ProxyQueuedProviderResolver.ensure(fakeSession);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    // rpush should have been called with "queue:waiting_users:default"
    const pipelineCalls = redisClientRef.pipeline.mock.results[0].value;
    expect(pipelineCalls.rpush).toHaveBeenCalledWith(
      "queue:waiting_users:default",
      expect.stringMatching(/^u:7:/)
    );
  });
});
