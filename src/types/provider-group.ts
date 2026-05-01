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
}

/**
 * Sticky configuration for one group, returned by getStickyConfig().
 * Used by the provider selector to gate sticky / cap / load-balancing logic.
 */
export interface ProviderGroupStickyConfig {
  enabled: boolean;
  ttlSec: number;
  cap: number | null;
}
