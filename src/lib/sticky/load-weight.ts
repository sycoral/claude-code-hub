import "server-only";

import { logger } from "@/lib/logger";
import { findWeeklyGroupScopedUsage, type GroupScopedUsageEntry } from "@/repository/leaderboard";
import { countEnabledProvidersInGroup } from "@/repository/provider-groups";

// User load weight derived from this-calendar-week token usage on the group's
// own accounts, with bucket sizes dynamically tied to the number of accounts in
// the group. Used by the sticky load-balancer (when loadSortMode = "weighted")
// to spread heavy users across providers — the goal is "every account ends up
// hosting at most one heavy user", not just "users are evenly counted".
//
// Why per-group: a user's "heaviness" only matters relative to the others
// competing for accounts in the same group. Ranking globally would tag a
// uniformly-heavy team as all-weight-3 and silently degrade back to headcount.
//
// Why scoped to *this group's accounts* (not the user's total weekly usage):
// a single user can run CC against one group and Codex against another. Counting
// the union would inflate weight for groups they barely touch and starve
// groups they actually live on. Filtering on `providers.groupTag` keeps the
// signal scoped to "load this user is putting on this group's accounts".
//
// Why account-count-aware bucket sizes: a fixed top-5%/top-20% threshold
// doesn't match the actual goal. With N accounts:
//   - top-N users      → HEAVY  (weight = N), so 1 heavy "occupies" one
//                                  account; a second heavy on the same account
//                                  would push that account's score to 2N,
//                                  far above any empty account's N → algorithm
//                                  spreads them out automatically.
//   - top-(N+1..2N)    → MEDIUM (weight = ceil(N/2)), so two mediums weigh
//                                  about as much as one heavy.
//   - rest             → NORMAL (weight = 1).
//
// Edge cases:
//   - N=2: medium=1, equal to normal → effectively two-tier. Acceptable.
//   - N=1: heavy=1, all weights equal → no differentiation, but with a single
//     account there's nothing to balance anyway.
//   - N=0: defensive fallback to legacy 5%/20% with weights 3/2/1 (group has
//     no enabled accounts, weight will not actually drive selection).
//
// Caching: 5-minute in-memory cache (per group) + in-flight dedupe, so the
// typical selection path is O(1) lookup against the map. The underlying DB
// query runs at most once per group per Node process per 5 minutes. N
// (enabled-providers-in-group) is captured at compute time and baked into the
// cached map; if you disable an account, the change takes effect after at most
// 5 minutes.

export const NORMAL_WEIGHT = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Defensive defaults used when N=0 (no enabled accounts in group).
const FALLBACK_HEAVY_WEIGHT = 3;
const FALLBACK_MEDIUM_WEIGHT = 2;

interface LoadWeightCache {
  map: Map<number, number>;
  cachedAt: number;
}

const cacheByGroup = new Map<string, LoadWeightCache>();
const inflightByGroup = new Map<string, Promise<Map<number, number>>>();

/**
 * Compute a uid → weight map for the given group. See file-level docstring
 * for the bucketing rule. Result is cached in-memory for 5 minutes per group.
 * Returns an empty map when the leaderboard query fails — callers should treat
 * lookup misses as NORMAL_WEIGHT.
 */
export async function getUserLoadWeights(groupName: string): Promise<Map<number, number>> {
  if (!groupName) return new Map();

  const now = Date.now();
  const cached = cacheByGroup.get(groupName);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.map;
  }

  const inflight = inflightByGroup.get(groupName);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const [providerCount, entries] = await Promise.all([
        countEnabledProvidersInGroup(groupName),
        findWeeklyGroupScopedUsage(groupName),
      ]);

      const map = computeWeightMap(entries, providerCount);
      cacheByGroup.set(groupName, { map, cachedAt: Date.now() });
      return map;
    } catch (error) {
      logger.error("LoadWeight: getUserLoadWeights failed", { error, groupName });
      const fallback = cacheByGroup.get(groupName)?.map ?? new Map<number, number>();
      cacheByGroup.set(groupName, { map: fallback, cachedAt: Date.now() });
      return fallback;
    } finally {
      inflightByGroup.delete(groupName);
    }
  })();

  inflightByGroup.set(groupName, promise);
  return promise;
}

/** Convenience: weight for a single uid in a group. Defaults to NORMAL_WEIGHT. */
export async function getUserLoadWeight(uid: number, groupName: string): Promise<number> {
  const map = await getUserLoadWeights(groupName);
  return map.get(uid) ?? NORMAL_WEIGHT;
}

/** Test hook: clears in-memory cache so the next call re-queries the source. */
export function clearLoadWeightCache(): void {
  cacheByGroup.clear();
  inflightByGroup.clear();
}

/**
 * Resolve the (heavyWeight, mediumWeight) pair for a given account count.
 * Exported for the admin UI so it can label badges with the same values the
 * selector uses, without re-deriving the formula.
 */
export function deriveWeightTiers(providerCount: number): {
  heavyWeight: number;
  mediumWeight: number;
} {
  if (providerCount <= 0) {
    return { heavyWeight: FALLBACK_HEAVY_WEIGHT, mediumWeight: FALLBACK_MEDIUM_WEIGHT };
  }
  return {
    heavyWeight: providerCount,
    mediumWeight: Math.ceil(providerCount / 2),
  };
}

export type LoadTier = "heavy" | "medium" | "normal";

/**
 * Look up the (providerCount-aware) weight thresholds for a group. Used by
 * UI/actions that need to translate raw weights into tier labels.
 */
export async function getGroupWeightThresholds(groupName: string): Promise<{
  heavyWeight: number;
  mediumWeight: number;
  providerCount: number;
}> {
  const providerCount = await countEnabledProvidersInGroup(groupName);
  const tiers = deriveWeightTiers(providerCount);
  return { ...tiers, providerCount };
}

/**
 * Map a raw weight to its display tier given the group's thresholds. Handles
 * degenerate cases (N=2 collapses medium to normal; N=1 collapses everything)
 * by only labeling tiers that are actually distinguishable.
 */
export function classifyLoadTier(
  weight: number,
  thresholds: { heavyWeight: number; mediumWeight: number }
): LoadTier {
  const { heavyWeight, mediumWeight } = thresholds;
  if (weight >= heavyWeight && heavyWeight > NORMAL_WEIGHT) return "heavy";
  if (weight >= mediumWeight && mediumWeight > NORMAL_WEIGHT) return "medium";
  return "normal";
}

/**
 * Bucket users into HEAVY / MEDIUM / NORMAL by past-7-days totalTokens rank.
 *
 * Bucket *sizes* are tied to the account count N:
 *   ranks 1..N         → HEAVY
 *   ranks (N+1)..(2N)  → MEDIUM
 *   rest               → NORMAL
 * Bucket *weights* (N, ceil(N/2), 1) are chosen so that two mediums weigh as
 * much as one heavy and N normals weigh as much as one heavy — making the
 * ideal balanced placement (1 heavy + 2 mediums + a few normals per account)
 * a local minimum of total weight.
 */
function computeWeightMap(
  entries: GroupScopedUsageEntry[],
  providerCount: number
): Map<number, number> {
  const map = new Map<number, number>();
  if (entries.length === 0) return map;

  const ranked = [...entries]
    .filter((e) => e.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  if (ranked.length === 0) return map;

  const { heavyWeight, mediumWeight } = deriveWeightTiers(providerCount);
  // When N=0 we still need bucket sizes; fall back to legacy fixed percentiles
  // so the map is non-trivial even before any provider is enabled.
  const heavyCount = providerCount > 0 ? providerCount : Math.ceil(ranked.length * 0.05);
  const mediumCount = providerCount > 0 ? providerCount * 2 : Math.ceil(ranked.length * 0.2);

  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i];
    if (!entry) continue;
    let weight: number;
    if (i < heavyCount) {
      weight = heavyWeight;
    } else if (i < mediumCount) {
      weight = mediumWeight;
    } else {
      weight = NORMAL_WEIGHT;
    }
    map.set(entry.userId, weight);
  }
  return map;
}
