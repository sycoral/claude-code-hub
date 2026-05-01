import "server-only";

import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";

// User-group sticky binding (V1, all-Redis state).
//
// Two structures:
//   `user:{uid}:group:{group}:provider` — string holding providerId.
//       String-level TTL = sticky window (rolling, refreshed on hit).
//   `provider:{pid}:group:{group}:active_users` — ZSet of users currently
//       sticky on that provider in that group. score = expiry epoch ms,
//       member = stringified uid. ZSet itself has no key TTL — entries are
//       lazy-cleaned via ZREMRANGEBYSCORE on read paths.
//
// All operations soft-fail when Redis is unavailable, mirroring SessionManager.

const userKey = (uid: number, group: string) => `user:${uid}:group:${group}:provider`;
const activeUsersKey = (pid: number, group: string) =>
  `provider:${pid}:group:${group}:active_users`;

function isRedisReady(
  redis: ReturnType<typeof getRedisClient>
): redis is NonNullable<ReturnType<typeof getRedisClient>> {
  return redis !== null && redis.status === "ready";
}

/**
 * Read the user's current sticky provider for a given group.
 * Returns null when no binding exists, Redis is down, or the stored value
 * cannot be parsed as a number.
 */
export async function getStickyProvider(uid: number, group: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return null;

  try {
    const value = await redis.get(userKey(uid, group));
    if (!value) return null;
    const id = Number.parseInt(value, 10);
    return Number.isFinite(id) ? id : null;
  } catch (error) {
    logger.error("UserGroupSticky: getStickyProvider failed", { error, uid, group });
    return null;
  }
}

/**
 * Bind user → provider for the given group with the given TTL (seconds).
 * Writes both the user binding key and adds the user to the provider's
 * active-users ZSet with score = nowMs + ttlSec * 1000.
 *
 * Uses a pipeline so the two writes share one round-trip. Not strictly atomic
 * across keys (would require Lua), but Redis is single-threaded so the
 * worst-case interleave is bounded.
 *
 * Returns true on success, false on any failure.
 */
export async function bindSticky(
  uid: number,
  group: string,
  providerId: number,
  ttlSec: number
): Promise<boolean> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return false;
  if (ttlSec <= 0) return false;

  try {
    const expireAtMs = Date.now() + ttlSec * 1000;
    const pipeline = redis.pipeline();
    pipeline.set(userKey(uid, group), providerId.toString(), "EX", ttlSec);
    pipeline.zadd(activeUsersKey(providerId, group), expireAtMs, uid.toString());
    const results = await pipeline.exec();
    if (!results) return false;
    for (const [err] of results) {
      if (err) {
        logger.error("UserGroupSticky: bindSticky pipeline reported error", {
          err,
          uid,
          group,
          providerId,
        });
        return false;
      }
    }
    return true;
  } catch (error) {
    logger.error("UserGroupSticky: bindSticky failed", {
      error,
      uid,
      group,
      providerId,
    });
    return false;
  }
}

/**
 * Refresh the TTL on an existing binding. Used after a successful sticky-hit
 * (including soft-fail fall-throughs) so an active user doesn't lose the
 * binding just because we happened to fall through this request.
 *
 * Updates both the string TTL and the ZSet score. ZADD GT only raises the
 * score; never lowers — protects against clock skew.
 */
export async function refreshStickyTTL(
  uid: number,
  group: string,
  providerId: number,
  ttlSec: number
): Promise<void> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return;
  if (ttlSec <= 0) return;

  try {
    const expireAtMs = Date.now() + ttlSec * 1000;
    const pipeline = redis.pipeline();
    pipeline.expire(userKey(uid, group), ttlSec);
    pipeline.zadd(activeUsersKey(providerId, group), "GT", expireAtMs, uid.toString());
    await pipeline.exec();
  } catch (error) {
    logger.error("UserGroupSticky: refreshStickyTTL failed", {
      error,
      uid,
      group,
      providerId,
    });
  }
}

/**
 * Clear the binding for a user in a group. Optionally also removes the user
 * from the provider's active-users ZSet — caller passes providerId when known
 * (e.g. when invalidating after a hard-failure on a known provider).
 *
 * If providerId is omitted, the ZSet is not touched here; in that case the
 * stale entry will be cleaned up lazily by countActiveUsers.
 */
export async function clearSticky(uid: number, group: string, providerId?: number): Promise<void> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return;

  try {
    const pipeline = redis.pipeline();
    pipeline.del(userKey(uid, group));
    if (providerId !== undefined) {
      pipeline.zrem(activeUsersKey(providerId, group), uid.toString());
    }
    await pipeline.exec();
  } catch (error) {
    logger.error("UserGroupSticky: clearSticky failed", {
      error,
      uid,
      group,
      providerId,
    });
  }
}

/**
 * Count distinct active users currently bound to a provider in a group.
 *
 * Side-effect: lazily prunes expired entries (score <= now) before counting.
 * This keeps the ZSet bounded without requiring a background job.
 *
 * Returns 0 when Redis is unavailable so the caller's load-balancing logic
 * degrades gracefully (treats every provider as 0-load).
 */
export async function countActiveUsers(pid: number, group: string): Promise<number> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return 0;

  const key = activeUsersKey(pid, group);
  const nowMs = Date.now();

  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, nowMs);
    pipeline.zcard(key);
    const results = await pipeline.exec();
    if (!results) return 0;
    const cardEntry = results[1];
    if (!cardEntry) return 0;
    const [err, value] = cardEntry;
    if (err) {
      logger.error("UserGroupSticky: countActiveUsers zcard error", { err, pid, group });
      return 0;
    }
    return typeof value === "number" ? value : 0;
  } catch (error) {
    logger.error("UserGroupSticky: countActiveUsers failed", { error, pid, group });
    return 0;
  }
}

/**
 * Check whether a user is currently counted as active on a given provider in
 * a group (i.e. has a non-expired ZSet entry). Used to exempt already-stuck
 * users from cap enforcement.
 */
export async function isUserCountedOn(pid: number, group: string, uid: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) return false;

  try {
    const score = await redis.zscore(activeUsersKey(pid, group), uid.toString());
    if (score == null) return false;
    const expireAtMs = Number.parseFloat(score);
    return Number.isFinite(expireAtMs) && expireAtMs > Date.now();
  } catch (error) {
    logger.error("UserGroupSticky: isUserCountedOn failed", { error, pid, group, uid });
    return false;
  }
}
