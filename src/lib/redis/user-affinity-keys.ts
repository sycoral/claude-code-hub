import "server-only";

/**
 * User Affinity & Provider User-Slot 相关 Redis key 生成器。
 *
 * 说明：
 * - 与 active-session-keys 不同，这里的 key **不需要 hash tag**：
 *   每个 lua 脚本一次只操作单一 provider 的 user_slot ZSET，不会触发 CROSSSLOT。
 * - affinity 是按 group 独立的：同一用户在不同 providerGroup 下各有各的亲和。
 * - provider user-slot 是跨 group 合计：一个 provider 最多被 N 个不同用户绑定
 *   （由 providers.limit_concurrent_users 控制），不区分用户来自哪个 group。
 */

/**
 * Provider 级活跃用户 ZSET（跨分组合计）。
 *
 * 数据结构：ZSET
 *   score = 最近活跃时间戳（ms）
 *   member = userId（字符串化）
 *
 * 用途：限制 provider 最多被多少个不同用户同时占用 user-slot。
 */
export function getProviderActiveUsersKey(providerId: number): string {
  return `provider:${providerId}:active_users`;
}

/**
 * User → Provider 亲和绑定（按分组，滑动 TTL）。
 *
 * 数据结构：STRING
 *   value = providerId（字符串化）
 *   TTL = USER_AFFINITY_TTL（默认 7 天），命中时刷新
 *
 * 用途：同一用户在同一 group 下优先分配到上次绑定的 provider。
 */
export function getUserAffinityKey(userId: number, groupTag: string): string {
  return `affinity:user:${userId}:group:${groupTag}`;
}
