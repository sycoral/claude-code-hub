"use server";

import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { conversationAuditLog } from "@/drizzle/audit-schema";
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

export interface AuditUserItem {
  userId: number;
  userName: string;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function requireAdmin(): Promise<ActionResult<never> | null> {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { ok: false, error: "Unauthorized" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. getAuditSessions — simple SELECT, no GROUP BY needed (one row per session)
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
      conditions.push(eq(conversationAuditLog.userId, userId));
    }
    if (model) {
      conditions.push(eq(conversationAuditLog.model, model));
    }
    if (search) {
      conditions.push(
        sql`(${ilike(conversationAuditLog.contentSummary, `%${search}%`)} OR ${ilike(conversationAuditLog.userName, `%${search}%`)} OR ${ilike(conversationAuditLog.sessionId, `%${search}%`)})`
      );
    }
    if (startDate) {
      conditions.push(gte(conversationAuditLog.createdAt, new Date(startDate)));
    }
    if (endDate) {
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(lte(conversationAuditLog.createdAt, endOfDay));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Count total sessions
    const totalResult = await db
      .select({ value: sql<number>`count(*)` })
      .from(conversationAuditLog)
      .where(whereClause);

    const total = Number(totalResult[0]?.value ?? 0);

    // Fetch paginated rows (one row = one session)
    const offset = (page - 1) * pageSize;
    const rows = await db
      .select()
      .from(conversationAuditLog)
      .where(whereClause)
      .orderBy(desc(conversationAuditLog.updatedAt))
      .offset(offset)
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const sessions: AuditSessionItem[] = rows.slice(0, pageSize).map((r) => ({
      sessionId: r.sessionId,
      userName: r.userName,
      model: r.model,
      firstSummary: r.contentSummary,
      requestCount: r.requestCount ?? 1,
      totalInputTokens: r.inputTokens ?? 0,
      totalOutputTokens: r.outputTokens ?? 0,
      totalCost: r.costUsd ?? "0",
      firstAt: r.createdAt?.toISOString() ?? "",
      lastAt: r.updatedAt?.toISOString() ?? "",
    }));

    return { ok: true, data: { sessions, total, hasMore } };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit sessions");
    return { ok: false, error: "Failed to fetch audit sessions" };
  }
}

// ---------------------------------------------------------------------------
// 2. getAuditChat — read JSONL file lines directly (all messages in one file)
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
    // Get the session record to find the JSONL file path
    const record = await db
      .select({
        contentPath: conversationAuditLog.contentPath,
        requestCount: conversationAuditLog.requestCount,
      })
      .from(conversationAuditLog)
      .where(eq(conversationAuditLog.sessionId, sessionId))
      .limit(1);

    if (record.length === 0 || !record[0].contentPath) {
      return { ok: true, data: { messages: [], hasMore: false, totalRecords: 0 } };
    }

    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    // Read all lines from the JSONL file
    const allLines = await store.readLines(record[0].contentPath, 0, Number.MAX_SAFE_INTEGER);
    const totalRecords = allLines.length;

    // Paginate on JSONL lines
    const offset = (page - 1) * pageSize;
    const pageLines = allLines.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < totalRecords;

    const messages: AuditChatMessage[] = [];
    for (const line of pageLines) {
      try {
        messages.push(JSON.parse(line) as AuditChatMessage);
      } catch {
        // skip malformed lines
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
      .selectDistinct({ model: conversationAuditLog.model })
      .from(conversationAuditLog)
      .where(sql`${conversationAuditLog.model} is not null`)
      .orderBy(conversationAuditLog.model);

    const models = rows.map((r) => r.model).filter((m): m is string => m != null);

    return { ok: true, data: models };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit models");
    return { ok: false, error: "Failed to fetch audit models" };
  }
}

// ---------------------------------------------------------------------------
// 4. getAuditUsers
// ---------------------------------------------------------------------------

export async function getAuditUsers(): Promise<ActionResult<AuditUserItem[]>> {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const rows = await db
      .selectDistinct({
        userId: conversationAuditLog.userId,
        userName: conversationAuditLog.userName,
      })
      .from(conversationAuditLog)
      .orderBy(conversationAuditLog.userName);

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
