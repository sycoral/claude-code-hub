/**
 * Within-tier load-balance ranking modes for a provider group.
 * - "headcount": rank candidates by distinct active user count (default).
 * - "weighted": rank by sum of per-user load-weights (heavy users count more),
 *   weights derived from past-7-days token usage. Use when heavy/light users
 *   would otherwise cluster on the same account.
 */
export type LoadSortMode = "headcount" | "weighted";

/**
 * Provider group entity.
 * Maps to the provider_groups table.
 */
export interface ProviderGroup {
  id: number;
  name: string;
  costMultiplier: number;
  description: string | null;
  stickyEnabled: boolean;
  stickyTtlHours: number;
  maxActiveUsersPerProvider: number | null;
  loadSortMode: LoadSortMode;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating a new provider group.
 */
export interface CreateProviderGroupInput {
  name: string;
  costMultiplier?: number;
  description?: string | null;
  stickyEnabled?: boolean;
  stickyTtlHours?: number;
  maxActiveUsersPerProvider?: number | null;
  loadSortMode?: LoadSortMode;
}

/**
 * Input for updating a provider group.
 */
export interface UpdateProviderGroupInput {
  costMultiplier?: number;
  description?: string | null;
  stickyEnabled?: boolean;
  stickyTtlHours?: number;
  maxActiveUsersPerProvider?: number | null;
  loadSortMode?: LoadSortMode;
}

/**
 * Sticky configuration for one group, returned by getStickyConfig().
 * Used by the provider selector to gate sticky / cap / load-balancing logic.
 */
export interface ProviderGroupStickyConfig {
  enabled: boolean;
  ttlSec: number;
  cap: number | null;
  loadSortMode: LoadSortMode;
}
