"use server";

import { and, count, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { auditLog } from "@/drizzle/audit-schema";
import { db } from "@/drizzle/db";
import { AuditFileStore } from "@/lib/audit/audit-file-store";
import { getSession } from "@/lib/auth";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { ActionResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditSessionItem = {
  sessionId: string | null;
  userName: string | null;
  model: string | null;
  firstSummary: string | null;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: string;
  firstAt: string;
  lastAt: string;
};

export type AuditChatMessage = {
  seq: number;
  ts: string;
  request: Record<string, unknown>;
  response: unknown;
  _meta: { size: number; truncated: boolean };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireAdmin(): Promise<ActionResult<never> | null> {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { ok: false, error: "Unauthorized" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. getAuditSessions
// ---------------------------------------------------------------------------

export async function getAuditSessions(params: {
  page: number;
  pageSize: number;
  userId?: number;
  model?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}): Promise<ActionResult<{ sessions: AuditSessionItem[]; total: number; hasMore: boolean }>> {
  const authError = await requireAdmin();
  if (authError) return authError;

  const { page, pageSize, userId, model, search, startDate, endDate } = params;

  try {
    const conditions = [];

    if (userId) {
      conditions.push(eq(auditLog.userId, userId));
    }
    if (model) {
      conditions.push(eq(auditLog.model, model));
    }
    if (search) {
      conditions.push(
        sql`(${ilike(auditLog.contentSummary, `%${search}%`)} OR ${ilike(auditLog.userName, `%${search}%`)} OR ${ilike(auditLog.sessionId, `%${search}%`)})`
      );
    }
    if (startDate) {
      conditions.push(gte(auditLog.createdAt, new Date(startDate)));
    }
    if (endDate) {
      // Set to end of day (23:59:59.999) so records from the endDate are included
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLog.createdAt, endOfDay));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Count total distinct sessions
    const totalResult = await db
      .select({ value: sql<number>`count(distinct ${auditLog.sessionId})` })
      .from(auditLog)
      .where(whereClause);

    const total = Number(totalResult[0]?.value ?? 0);

    // Fetch grouped sessions with limit+1 trick for hasMore
    const offset = (page - 1) * pageSize;
    const limit = pageSize + 1;

    const rows = await db
      .select({
        sessionId: auditLog.sessionId,
        userName: sql<string | null>`min(${auditLog.userName})`,
        model: sql<string | null>`mode() within group (order by ${auditLog.model})`,
        firstSummary: sql<
          string | null
        >`(array_agg(${auditLog.contentSummary} order by ${auditLog.createdAt} asc))[1]`,
        requestCount: sql<number>`count(*)::int`,
        totalInputTokens: sql<number>`coalesce(sum(${auditLog.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${auditLog.outputTokens}), 0)::int`,
        totalCost: sql<string>`coalesce(sum(${auditLog.costUsd}), 0)::text`,
        firstAt: sql<string>`min(${auditLog.createdAt})::text`,
        lastAt: sql<string>`max(${auditLog.createdAt})::text`,
      })
      .from(auditLog)
      .where(whereClause)
      .groupBy(auditLog.sessionId)
      .orderBy(desc(sql`max(${auditLog.createdAt})`))
      .offset(offset)
      .limit(limit);

    const hasMore = rows.length > pageSize;
    const sessions: AuditSessionItem[] = rows.slice(0, pageSize).map((r) => ({
      sessionId: r.sessionId,
      userName: r.userName,
      model: r.model,
      firstSummary: r.firstSummary,
      requestCount: r.requestCount,
      totalInputTokens: r.totalInputTokens,
      totalOutputTokens: r.totalOutputTokens,
      totalCost: r.totalCost,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    }));

    return { ok: true, data: { sessions, total, hasMore } };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit sessions");
    return { ok: false, error: "Failed to fetch audit sessions" };
  }
}

// ---------------------------------------------------------------------------
// 2. getAuditChat
// ---------------------------------------------------------------------------

export async function getAuditChat(params: {
  sessionId: string;
  page: number;
  pageSize: number;
}): Promise<
  ActionResult<{ messages: AuditChatMessage[]; hasMore: boolean; totalRecords: number }>
> {
  const authError = await requireAdmin();
  if (authError) return authError;

  const { sessionId, page, pageSize } = params;

  try {
    // Count total records for this session
    const countResult = await db
      .select({ value: count() })
      .from(auditLog)
      .where(eq(auditLog.sessionId, sessionId));

    const totalRecords = Number(countResult[0]?.value ?? 0);

    // Fetch paginated audit_log rows ordered by requestSeq
    const offset = (page - 1) * pageSize;
    const limit = pageSize + 1;

    const rows = await db
      .select({
        requestSeq: auditLog.requestSeq,
        contentPath: auditLog.contentPath,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.sessionId, sessionId))
      .orderBy(auditLog.requestSeq)
      .offset(offset)
      .limit(limit);

    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);

    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    const messages: AuditChatMessage[] = [];

    for (const row of pageRows) {
      if (!row.contentPath) {
        // No file content, build a minimal placeholder
        messages.push({
          seq: row.requestSeq ?? 0,
          ts: row.createdAt?.toISOString() ?? "",
          request: {},
          response: null,
          _meta: { size: 0, truncated: false },
        });
        continue;
      }

      try {
        // Read all lines from the file and find the matching seq
        const lines = await store.readLines(row.contentPath, 0, Number.MAX_SAFE_INTEGER);
        let found = false;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as AuditChatMessage;
            if (parsed.seq === (row.requestSeq ?? 0)) {
              messages.push(parsed);
              found = true;
              break;
            }
          } catch {
            // skip malformed lines
          }
        }

        if (!found) {
          messages.push({
            seq: row.requestSeq ?? 0,
            ts: row.createdAt?.toISOString() ?? "",
            request: {},
            response: null,
            _meta: { size: 0, truncated: false },
          });
        }
      } catch (fileErr) {
        logger.warn({ err: fileErr, contentPath: row.contentPath }, "Failed to read audit file");
        messages.push({
          seq: row.requestSeq ?? 0,
          ts: row.createdAt?.toISOString() ?? "",
          request: {},
          response: null,
          _meta: { size: 0, truncated: false },
        });
      }
    }

    return { ok: true, data: { messages, hasMore, totalRecords } };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit chat");
    return { ok: false, error: "Failed to fetch audit chat" };
  }
}

// ---------------------------------------------------------------------------
// 3. getAuditModels
// ---------------------------------------------------------------------------

export async function getAuditModels(): Promise<ActionResult<string[]>> {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const rows = await db
      .selectDistinct({ model: auditLog.model })
      .from(auditLog)
      .where(sql`${auditLog.model} is not null`)
      .orderBy(auditLog.model);

    const models = rows.map((r) => r.model).filter((m): m is string => m != null);

    return { ok: true, data: models };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit models");
    return { ok: false, error: "Failed to fetch audit models" };
  }
}

export interface AuditUserItem {
  userId: number;
  userName: string;
}

export async function getAuditUsers(): Promise<ActionResult<AuditUserItem[]>> {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const rows = await db
      .selectDistinct({
        userId: auditLog.userId,
        userName: auditLog.userName,
      })
      .from(auditLog)
      .orderBy(auditLog.userName);

    const users = rows
      .filter((r) => r.userId != null)
      .map((r) => ({
        userId: r.userId,
        userName: r.userName ?? `User ${r.userId}`,
      }));

    return { ok: true, data: users };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit users");
    return { ok: false, error: "Failed to fetch audit users" };
  }
}
