import "server-only";

import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";
import { getUserAffinityKey } from "./user-affinity-keys";

/**
 * User affinity 的滑动 TTL（秒）。默认 7 天。
 * 每次 getUserAffinity 命中时刷新；长期不活跃的用户自动失效，账号位回收。
 */
const USER_AFFINITY_TTL_SECONDS = (() => {
  const parsed = Number.parseInt(process.env.USER_AFFINITY_TTL ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7 * 24 * 60 * 60;
})();

export const USER_AFFINITY_TTL_SECONDS_FOR_TESTING = USER_AFFINITY_TTL_SECONDS;

/**
 * 读取 user affinity，命中则滑动续期 TTL。
 * Redis 不可用或未命中时返回 null（由调用方回退到全局分配）。
 */
export async function getUserAffinity(userId: number, groupTag: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return null;

  try {
    const key = getUserAffinityKey(userId, groupTag);
    const pipeline = redis.pipeline();
    pipeline.get(key);
    pipeline.expire(key, USER_AFFINITY_TTL_SECONDS);
    const results = await pipeline.exec();

    const raw = results?.[0]?.[1];
    if (typeof raw !== "string" || raw.length === 0) return null;

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (error) {
    logger.error("[UserAffinity] getUserAffinity failed", { error, userId, groupTag });
    return null;
  }
}

/**
 * 写入 user affinity（覆盖已有绑定 + 重置 TTL）。
 * 通常在 provider 成功占用后调用一次。
 */
export async function setUserAffinity(
  userId: number,
  groupTag: string,
  providerId: number
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;

  try {
    const key = getUserAffinityKey(userId, groupTag);
    await redis.setex(key, USER_AFFINITY_TTL_SECONDS, providerId.toString());
  } catch (error) {
    logger.error("[UserAffinity] setUserAffinity failed", {
      error,
      userId,
      groupTag,
      providerId,
    });
  }
}

/**
 * 显式清除 user affinity（供管理后台/主动迁移使用）。
 */
export async function clearUserAffinity(userId: number, groupTag: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;

  try {
    const key = getUserAffinityKey(userId, groupTag);
    await redis.del(key);
  } catch (error) {
    logger.error("[UserAffinity] clearUserAffinity failed", { error, userId, groupTag });
  }
}
