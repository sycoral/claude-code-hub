import type { Provider } from "@/types/provider";

/**
 * Resolve the effective active-user cap for a provider within a group.
 *
 * Precedence: per-provider override > group default.
 * `null` means "no cap".
 */
export function resolveEffectiveProviderCap(
  provider: Pick<Provider, "maxActiveUsersOverride">,
  groupDefault: number | null
): number | null {
  return provider.maxActiveUsersOverride ?? groupDefault;
}
