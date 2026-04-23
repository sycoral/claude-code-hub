import "server-only";

import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis/client";
import { getEffectiveProviderGroup, ProxyProviderResolver } from "./provider-selector";
import type { ProxySession } from "./session";

const QUEUE_WAIT_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.QUEUE_WAIT_TIMEOUT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 30 * 1000;
})();

const QUEUE_POLL_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.QUEUE_POLL_INTERVAL ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 2 * 1000;
})();

/**
 * 暴露给测试的常量（毫秒）。生产代码请用 env 覆盖：
 *   QUEUE_WAIT_TIMEOUT=30        // 秒
 *   QUEUE_POLL_INTERVAL=2        // 秒
 */
export const QUEUE_WAIT_TIMEOUT_MS_FOR_TESTING = QUEUE_WAIT_TIMEOUT_MS;
export const QUEUE_POLL_INTERVAL_MS_FOR_TESTING = QUEUE_POLL_INTERVAL_MS;

function getQueueKey(groupTag: string): string {
  return `queue:waiting_users:${groupTag}`;
}

/**
 * Provider 选择 + 排队：当整个分组内的所有 provider 都暂时不可用（user-slot 满 / session-slot 满 /
 * 熔断 / 限流等）时，把当前请求挂在组级队列上，短轮询等待别人的 slot 释放后自动继续。
 *
 * 语义：
 *  - ensure 成功 → 立即返回 null
 *  - ensure 失败且 status 非 503 → 直接返回原 Response，不排队（非暂时性错误）
 *  - ensure 失败且 status = 503 → 进入排队：
 *      - 入队（RPUSH queue:waiting_users:{group}，仅用于可观察性，非严格 FIFO）
 *      - 每 POLL_INTERVAL_MS 毫秒重试一次 ensure
 *      - 命中 → 立即返回 null
 *      - 超时（WAIT_TIMEOUT_MS）→ 返回最后一次的 503 + Retry-After
 *      - 期间出现非 503 错误 → 直接返回，不继续排队
 *  - Redis 不可用时：不入队但仍进行轮询（排队的"公平性"退化，但"等待 slot 释放"这件事仍能工作）
 */
export class ProxyQueuedProviderResolver {
  static async ensure(session: ProxySession): Promise<Response | null> {
    const first = await ProxyProviderResolver.ensure(session);
    if (first === null) return null;
    if (first.status !== 503) return first;

    const groupTag = getEffectiveProviderGroup(session) ?? "default";
    const userId = session.authState?.user?.id;
    const sessionId = session.sessionId ?? "<no-session>";
    const entry = userId ? `u:${userId}:${Date.now()}` : `s:${sessionId}:${Date.now()}`;
    const queueKey = getQueueKey(groupTag);

    await pushQueue(queueKey, entry);

    logger.info("ProviderQueue: entering wait loop", {
      userId,
      groupTag,
      pollIntervalMs: QUEUE_POLL_INTERVAL_MS,
      timeoutMs: QUEUE_WAIT_TIMEOUT_MS,
      sessionId,
    });

    let lastResponse = first;
    try {
      const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(QUEUE_POLL_INTERVAL_MS);
        const result = await ProxyProviderResolver.ensure(session);
        if (result === null) {
          logger.info("ProviderQueue: resolved while waiting", { userId, groupTag, sessionId });
          return null;
        }
        // 非 503 错误不属于"临时资源紧张"，立刻返回
        if (result.status !== 503) {
          return result;
        }
        lastResponse = result;
      }
    } finally {
      await popQueue(queueKey, entry);
    }

    logger.warn("ProviderQueue: wait timeout, returning 503 with Retry-After", {
      userId,
      groupTag,
      sessionId,
      waitedMs: QUEUE_WAIT_TIMEOUT_MS,
    });
    return await withRetryAfter(lastResponse, Math.ceil(QUEUE_WAIT_TIMEOUT_MS / 1000));
  }
}

async function pushQueue(key: string, entry: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;
  try {
    const pipeline = redis.pipeline();
    pipeline.rpush(key, entry);
    // 设置保护性 TTL，防止 key 因为 peek/pop 失败堆积
    pipeline.expire(key, Math.max(60, Math.ceil(QUEUE_WAIT_TIMEOUT_MS / 1000) * 2));
    await pipeline.exec();
  } catch (err) {
    logger.warn("ProviderQueue: push failed (ignored)", { error: err, key });
  }
}

async function popQueue(key: string, entry: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;
  try {
    await redis.lrem(key, 1, entry);
  } catch (err) {
    logger.warn("ProviderQueue: pop failed (ignored)", { error: err, key });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在原 Response 上附加 Retry-After header（body 为 string，可安全读取重构）。
 */
async function withRetryAfter(response: Response, retryAfterSeconds: number): Promise<Response> {
  try {
    const body = await response.clone().text();
    const headers = new Headers(response.headers);
    headers.set("Retry-After", retryAfterSeconds.toString());
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    logger.warn("ProviderQueue: failed to attach Retry-After, returning original", { error: err });
    return response;
  }
}
