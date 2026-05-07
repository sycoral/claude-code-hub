"use server";

import { inArray } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/drizzle/db";
import { users as usersTable } from "@/drizzle/schema";
import { emitActionAudit } from "@/lib/audit/emit";
import { getSession } from "@/lib/auth";
import { PROVIDER_GROUP } from "@/lib/constants/provider.constants";
import { logger } from "@/lib/logger";
import { bootstrapProviderGroupsFromProviders } from "@/lib/provider-groups/bootstrap";
import {
  parsePublicStatusDescription,
  serializePublicStatusDescription,
} from "@/lib/public-status/config";
import { exceedsProviderGroupDescriptionLimit } from "@/lib/public-status/description-limit";
import {
  classifyLoadTier,
  getGroupWeightThresholds,
  getUserLoadWeights,
  type LoadTier,
  NORMAL_WEIGHT,
} from "@/lib/sticky/load-weight";
import { clearSticky, countActiveUsers, listActiveUsers } from "@/lib/sticky/user-group-sticky";
import { ERROR_CODES } from "@/lib/utils/error-messages";
import {
  countProvidersUsingGroup,
  findProviderGroupById,
  findProviderGroupByName,
  createProviderGroup as repoCreateProviderGroup,
  deleteProviderGroup as repoDeleteProviderGroup,
  updateProviderGroup as repoUpdateProviderGroup,
} from "@/repository/provider-groups";
import type { ProviderGroup } from "@/types/provider-group";
import type { ActionResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderGroupWithCount = ProviderGroup & {
  providerCount: number;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Return all provider groups with the number of providers in each group.
 * Admin-only.
 */
export async function getProviderGroups(): Promise<ActionResult<ProviderGroupWithCount[]>> {
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }

    const { groups, groupCounts } = await bootstrapProviderGroupsFromProviders({
      logSelfHealFailure: (error, missing) => {
        logger.warn("getProviderGroups:self_heal_failed", {
          error: error instanceof Error ? error.message : String(error),
          missingCount: missing.length,
        });
      },
    });

    const data: ProviderGroupWithCount[] = groups.map((group) => ({
      ...group,
      providerCount: groupCounts.get(group.name) || 0,
    }));

    return { ok: true, data };
  } catch (error) {
    logger.error("Failed to fetch provider groups:", error);
    return {
      ok: false,
      error: tError("OPERATION_FAILED"),
      errorCode: ERROR_CODES.OPERATION_FAILED,
    };
  }
}

const STICKY_TTL_HOURS_MIN = 1;
const STICKY_TTL_HOURS_MAX = 720; // 30 days
const LOAD_SORT_MODES = ["headcount", "weighted"] as const;
type LoadSortMode = (typeof LOAD_SORT_MODES)[number];

function isLoadSortMode(value: unknown): value is LoadSortMode {
  return LOAD_SORT_MODES.includes(value as LoadSortMode);
}

function validateStickyFields(
  input: {
    stickyEnabled?: boolean;
    stickyTtlHours?: number;
    maxActiveUsersPerProvider?: number | null;
    loadSortMode?: LoadSortMode;
  },
  t: (key: string) => string
): { ok: false; error: string; errorCode: string } | { ok: true } {
  if (input.stickyTtlHours !== undefined) {
    if (
      !Number.isInteger(input.stickyTtlHours) ||
      input.stickyTtlHours < STICKY_TTL_HOURS_MIN ||
      input.stickyTtlHours > STICKY_TTL_HOURS_MAX
    ) {
      return { ok: false, error: t("invalidStickyTtl"), errorCode: "INVALID_STICKY_TTL" };
    }
  }
  if (input.maxActiveUsersPerProvider !== undefined && input.maxActiveUsersPerProvider !== null) {
    if (!Number.isInteger(input.maxActiveUsersPerProvider) || input.maxActiveUsersPerProvider < 1) {
      return {
        ok: false,
        error: t("invalidMaxActiveUsers"),
        errorCode: "INVALID_MAX_ACTIVE_USERS",
      };
    }
  }
  if (input.loadSortMode !== undefined && !isLoadSortMode(input.loadSortMode)) {
    return {
      ok: false,
      error: t("invalidLoadSortMode"),
      errorCode: "INVALID_LOAD_SORT_MODE",
    };
  }
  return { ok: true };
}

/**
 * Create a new provider group.
 * Admin-only. Validates name is non-empty and not duplicate, costMultiplier >= 0.
 */
export async function createProviderGroup(input: {
  name: string;
  costMultiplier?: number;
  description?: string;
  stickyEnabled?: boolean;
  stickyTtlHours?: number;
  maxActiveUsersPerProvider?: number | null;
  loadSortMode?: LoadSortMode;
}): Promise<ActionResult<ProviderGroup>> {
  const t = await getTranslations("settings.providers.providerGroups");
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }

    const name = input.name?.trim();
    if (!name) {
      return { ok: false, error: t("nameRequired"), errorCode: "NAME_REQUIRED" };
    }

    if (
      input.costMultiplier !== undefined &&
      (!Number.isFinite(input.costMultiplier) || input.costMultiplier < 0)
    ) {
      return {
        ok: false,
        error: t("invalidMultiplier"),
        errorCode: "INVALID_MULTIPLIER",
      };
    }

    // Check for duplicate name
    const existing = await findProviderGroupByName(name);
    if (existing) {
      return {
        ok: false,
        error: t("duplicateName"),
        errorCode: "DUPLICATE_NAME",
      };
    }

    if (exceedsProviderGroupDescriptionLimit(input.description)) {
      return {
        ok: false,
        error: t("descriptionTooLong"),
        errorCode: "DESCRIPTION_TOO_LONG",
      };
    }

    const stickyValidation = validateStickyFields(input, t);
    if (!stickyValidation.ok) {
      return stickyValidation;
    }

    const group = await repoCreateProviderGroup({
      name,
      costMultiplier: input.costMultiplier,
      description: input.description ?? null,
      stickyEnabled: input.stickyEnabled,
      stickyTtlHours: input.stickyTtlHours,
      maxActiveUsersPerProvider: input.maxActiveUsersPerProvider,
      loadSortMode: input.loadSortMode,
    });

    emitActionAudit({
      category: "provider_group",
      action: "provider_group.create",
      targetType: "provider_group",
      targetId: String(group.id),
      targetName: group.name,
      after: {
        id: group.id,
        name: group.name,
        costMultiplier: group.costMultiplier,
        description: group.description,
        stickyEnabled: group.stickyEnabled,
        stickyTtlHours: group.stickyTtlHours,
        maxActiveUsersPerProvider: group.maxActiveUsersPerProvider,
        loadSortMode: group.loadSortMode,
      },
      success: true,
    });
    return { ok: true, data: group };
  } catch (error) {
    logger.error("Failed to create provider group:", error);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.create",
      targetType: "provider_group",
      targetName: input.name?.trim() ?? null,
      success: false,
      errorMessage: "CREATE_FAILED",
    });
    return { ok: false, error: t("createFailed"), errorCode: ERROR_CODES.CREATE_FAILED };
  }
}

/**
 * Update an existing provider group by id.
 * Admin-only.
 */
export async function updateProviderGroup(
  id: number,
  input: {
    costMultiplier?: number;
    description?: string | null;
    descriptionNote?: string | null;
    stickyEnabled?: boolean;
    stickyTtlHours?: number;
    maxActiveUsersPerProvider?: number | null;
    loadSortMode?: LoadSortMode;
  }
): Promise<ActionResult<ProviderGroup>> {
  const t = await getTranslations("settings.providers.providerGroups");
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }

    if (
      input.costMultiplier !== undefined &&
      (!Number.isFinite(input.costMultiplier) || input.costMultiplier < 0)
    ) {
      return {
        ok: false,
        error: t("invalidMultiplier"),
        errorCode: "INVALID_MULTIPLIER",
      };
    }

    const beforeGroup = await findProviderGroupById(id);
    const nextDescription =
      input.descriptionNote !== undefined
        ? serializePublicStatusDescription({
            note: input.descriptionNote,
            publicStatus: parsePublicStatusDescription(beforeGroup?.description).publicStatus,
          })
        : input.description;
    if (exceedsProviderGroupDescriptionLimit(nextDescription)) {
      return {
        ok: false,
        error: t("descriptionTooLong"),
        errorCode: "DESCRIPTION_TOO_LONG",
      };
    }

    const stickyValidation = validateStickyFields(input, t);
    if (!stickyValidation.ok) {
      return stickyValidation;
    }

    const updated = await repoUpdateProviderGroup(id, {
      costMultiplier: input.costMultiplier,
      description: nextDescription,
      stickyEnabled: input.stickyEnabled,
      stickyTtlHours: input.stickyTtlHours,
      maxActiveUsersPerProvider: input.maxActiveUsersPerProvider,
      loadSortMode: input.loadSortMode,
    });

    if (!updated) {
      return { ok: false, error: tError("NOT_FOUND"), errorCode: ERROR_CODES.NOT_FOUND };
    }

    emitActionAudit({
      category: "provider_group",
      action: "provider_group.update",
      targetType: "provider_group",
      targetId: String(id),
      targetName: updated.name,
      before: beforeGroup ?? undefined,
      after: {
        id: updated.id,
        name: updated.name,
        costMultiplier: updated.costMultiplier,
        description: updated.description,
        stickyEnabled: updated.stickyEnabled,
        stickyTtlHours: updated.stickyTtlHours,
        maxActiveUsersPerProvider: updated.maxActiveUsersPerProvider,
        loadSortMode: updated.loadSortMode,
      },
      success: true,
    });
    return { ok: true, data: updated };
  } catch (error) {
    logger.error("Failed to update provider group:", error);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.update",
      targetType: "provider_group",
      targetId: String(id),
      success: false,
      errorMessage: "UPDATE_FAILED",
    });
    return { ok: false, error: t("updateFailed"), errorCode: ERROR_CODES.UPDATE_FAILED };
  }
}

/**
 * Delete a provider group by id.
 * Admin-only. Cannot delete the "default" group.
 */
export async function deleteProviderGroup(id: number): Promise<ActionResult<void>> {
  const t = await getTranslations("settings.providers.providerGroups");
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }

    // Pre-check: verify group exists and is not referenced by any provider.
    const existing = await findProviderGroupById(id);
    if (!existing) {
      return { ok: false, error: tError("NOT_FOUND"), errorCode: ERROR_CODES.NOT_FOUND };
    }

    if (existing.name === PROVIDER_GROUP.DEFAULT) {
      return {
        ok: false,
        error: t("cannotDeleteDefault"),
        errorCode: "CANNOT_DELETE_DEFAULT",
      };
    }

    const referenceCount = await countProvidersUsingGroup(existing.name);
    if (referenceCount > 0) {
      return {
        ok: false,
        error: t("groupInUse"),
        errorCode: "GROUP_IN_USE",
      };
    }

    await repoDeleteProviderGroup(id);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.delete",
      targetType: "provider_group",
      targetId: String(id),
      targetName: existing.name,
      before: existing,
      success: true,
    });
    return { ok: true, data: undefined };
  } catch (error) {
    // The default-group case is handled by the explicit pre-check above; the
    // repository's string-matched fallback is belt-and-suspenders only.
    logger.error("Failed to delete provider group:", error);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.delete",
      targetType: "provider_group",
      targetId: String(id),
      success: false,
      errorMessage: "DELETE_FAILED",
    });
    return { ok: false, error: t("deleteFailed"), errorCode: ERROR_CODES.DELETE_FAILED };
  }
}

// ---------------------------------------------------------------------------
// Sticky binding inspection / eviction (admin-only)
// ---------------------------------------------------------------------------

export interface StickyActiveUser {
  uid: number;
  name: string | null;
  expireAtMs: number;
  loadWeight: number;
  loadTier: LoadTier;
}

/**
 * Return active users currently bound to a provider in a group, joined with
 * user names. Admin-only.
 */
export async function listStickyActiveUsers(
  groupName: string,
  providerId: number
): Promise<ActionResult<StickyActiveUser[]>> {
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }
    if (!groupName || !Number.isInteger(providerId) || providerId <= 0) {
      return {
        ok: false,
        error: tError("INVALID_FORMAT"),
        errorCode: ERROR_CODES.INVALID_FORMAT,
      };
    }

    const entries = await listActiveUsers(providerId, groupName);
    if (entries.length === 0) {
      return { ok: true, data: [] };
    }

    const uids = entries.map((entry) => entry.uid);
    const [userRows, weights, thresholds] = await Promise.all([
      db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(inArray(usersTable.id, uids)),
      getUserLoadWeights(groupName),
      getGroupWeightThresholds(groupName),
    ]);
    const nameById = new Map(userRows.map((row) => [row.id, row.name] as const));

    const data: StickyActiveUser[] = entries.map((entry) => {
      const loadWeight = weights.get(entry.uid) ?? NORMAL_WEIGHT;
      return {
        uid: entry.uid,
        name: nameById.get(entry.uid) ?? null,
        expireAtMs: entry.expireAtMs,
        loadWeight,
        loadTier: classifyLoadTier(loadWeight, thresholds),
      };
    });
    return { ok: true, data };
  } catch (error) {
    logger.error("Failed to list sticky active users:", error);
    return {
      ok: false,
      error: tError("OPERATION_FAILED"),
      errorCode: ERROR_CODES.OPERATION_FAILED,
    };
  }
}

/**
 * Evict a single user's sticky binding from a provider in a group.
 * Removes both the user→provider key and the user's ZSet entry. Admin-only.
 */
export async function evictStickyUser(
  groupName: string,
  providerId: number,
  uid: number
): Promise<ActionResult<undefined>> {
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }
    if (
      !groupName ||
      !Number.isInteger(providerId) ||
      providerId <= 0 ||
      !Number.isInteger(uid) ||
      uid <= 0
    ) {
      return {
        ok: false,
        error: tError("INVALID_FORMAT"),
        errorCode: ERROR_CODES.INVALID_FORMAT,
      };
    }

    await clearSticky(uid, groupName, providerId);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.sticky.evict",
      targetType: "provider_group",
      targetName: groupName,
      after: { providerId, uid },
      success: true,
    });
    return { ok: true, data: undefined };
  } catch (error) {
    logger.error("Failed to evict sticky user:", error);
    emitActionAudit({
      category: "provider_group",
      action: "provider_group.sticky.evict",
      targetType: "provider_group",
      targetName: groupName,
      success: false,
      errorMessage: "OPERATION_FAILED",
    });
    return {
      ok: false,
      error: tError("OPERATION_FAILED"),
      errorCode: ERROR_CODES.OPERATION_FAILED,
    };
  }
}

/**
 * Return active-user counts keyed by provider id for a single group.
 * Admin-only. Used by the group-expansion table to populate the active-users
 * column without N round-trips from the client.
 */
export async function countStickyActiveUsersByProvider(
  groupName: string,
  providerIds: number[]
): Promise<ActionResult<Record<number, number>>> {
  const tError = await getTranslations("errors");
  try {
    const session = await getSession();
    if (!session || session.user.role !== "admin") {
      return { ok: false, error: tError("UNAUTHORIZED"), errorCode: ERROR_CODES.UNAUTHORIZED };
    }
    if (!groupName || !Array.isArray(providerIds)) {
      return {
        ok: false,
        error: tError("INVALID_FORMAT"),
        errorCode: ERROR_CODES.INVALID_FORMAT,
      };
    }
    const sanitized = Array.from(
      new Set(providerIds.filter((id) => Number.isInteger(id) && id > 0))
    );
    if (sanitized.length === 0) {
      return { ok: true, data: {} };
    }

    const counts = await Promise.all(
      sanitized.map((id) => countActiveUsers(id, groupName).then((c) => [id, c] as const))
    );
    const data: Record<number, number> = {};
    for (const [id, count] of counts) {
      data[id] = count;
    }
    return { ok: true, data };
  } catch (error) {
    logger.error("Failed to count sticky active users:", error);
    return {
      ok: false,
      error: tError("OPERATION_FAILED"),
      errorCode: ERROR_CODES.OPERATION_FAILED,
    };
  }
}
