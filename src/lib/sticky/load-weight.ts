import "server-only";

import { logger } from "@/lib/logger";
import { getLeaderboardWithCache } from "@/lib/redis/leaderboard-cache";
import type { LeaderboardEntry } from "@/repository/leaderboard";
import { getSystemSettings } from "@/repository/system-config";

// User load weight derived from past-7-days token usage. Used by the sticky
// load-balancer to spread heavy users across providers (instead of merely
// minimizing distinct user count, which treats heavy and light users equal).
//
// Strategy: rank all users in the past-7-days leaderboard by totalTokens desc,
// then assign weights by percentile bucket. Lazy + cached: we reuse the
// existing `leaderboard:user:weekly` Redis cache (60s TTL with thundering-herd
// lock) and add a 5-minute in-memory bucketing cache on top — so a typical
// selection path is O(1) lookup with zero extra Redis/DB pressure.
//
// Users not present in the leaderboard (no usage in past 7 days) default to
// NORMAL_WEIGHT.

export const HEAVY_WEIGHT = 3;
export const MEDIUM_WEIGHT = 2;
export const NORMAL_WEIGHT = 1;

const TOP_HEAVY_PERCENTILE = 0.05;
const TOP_MEDIUM_PERCENTILE = 0.2;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface LoadWeightCache {
  map: Map<number, number>;
  cachedAt: number;
}

let cache: LoadWeightCache | null = null;
let inflight: Promise<Map<number, number>> | null = null;

/**
 * Compute a uid → weight map. Result is cached in-memory for 5 minutes; the
 * underlying leaderboard query has its own 60s Redis cache + lock, so cold
 * misses don't stampede. Returns an empty map when the leaderboard query
 * fails — callers should treat lookup misses as NORMAL_WEIGHT.
 */
export async function getUserLoadWeights(): Promise<Map<number, number>> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.map;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const settings = await getSystemSettings();
      const currency = settings?.currencyDisplay ?? "USD";
      const data = await getLeaderboardWithCache("weekly", currency, "user");
      const entries = data as LeaderboardEntry[];

      const map = computeWeightMap(entries);
      cache = { map, cachedAt: Date.now() };
      return map;
    } catch (error) {
      logger.error("LoadWeight: getUserLoadWeights failed", { error });
      const fallback = cache?.map ?? new Map<number, number>();
      cache = { map: fallback, cachedAt: Date.now() };
      return fallback;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Convenience: weight for a single uid. Defaults to NORMAL_WEIGHT. */
export async function getUserLoadWeight(uid: number): Promise<number> {
  const map = await getUserLoadWeights();
  return map.get(uid) ?? NORMAL_WEIGHT;
}

/** Test hook: clears in-memory cache so the next call re-queries the source. */
export function clearLoadWeightCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Bucket users into HEAVY / MEDIUM / NORMAL by past-7-days totalTokens rank.
 * `Math.ceil` ensures small populations still produce a non-empty heavy bucket
 * (e.g. 3 users → 1 heavy, 1 medium, 1 normal) so the algorithm doesn't
 * silently degrade to "everyone is normal" on small instances.
 */
function computeWeightMap(entries: LeaderboardEntry[]): Map<number, number> {
  const map = new Map<number, number>();
  if (entries.length === 0) return map;

  const ranked = [...entries]
    .filter((e) => e.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  if (ranked.length === 0) return map;

  const heavyCount = Math.ceil(ranked.length * TOP_HEAVY_PERCENTILE);
  const mediumCount = Math.ceil(ranked.length * TOP_MEDIUM_PERCENTILE);

  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i];
    if (!entry) continue;
    let weight: number;
    if (i < heavyCount) {
      weight = HEAVY_WEIGHT;
    } else if (i < mediumCount) {
      weight = MEDIUM_WEIGHT;
    } else {
      weight = NORMAL_WEIGHT;
    }
    map.set(entry.userId, weight);
  }
  return map;
}
