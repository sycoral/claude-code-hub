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
  userId: number;
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

// One real user input, scoped across ALL of a user's sessions.
// Used by the user-centric "real inputs" view for deep-linking back into
// the session chat at the exact seq/index.
export type AuditUserRealInput = {
  sessionId: string;
  seq: number;
  idx: number; // index within msgList of the seq
  ts: string;
  model: string | null;
  content: string; // already extracted, tool blocks stripped
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
      userId: r.userId,
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
  // Optional: when a deep link asks for a specific seq, server finds the
  // page containing it and returns that page instead. Client then scrolls
  // to the matching bubble.
  targetSeq?: number;
}): Promise<
  ActionResult<{
    messages: AuditChatMessage[];
    hasMore: boolean;
    totalRecords: number;
    page: number;
  }>
> {
  const authError = await requireAdmin();
  if (authError) return authError;

  const { sessionId, pageSize, targetSeq } = params;
  let page = params.page;

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
      return { ok: true, data: { messages: [], hasMore: false, totalRecords: 0, page: 1 } };
    }

    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    // Read all lines from the JSONL file
    const allLines = await store.readLines(record[0].contentPath, 0, Number.MAX_SAFE_INTEGER);
    const totalRecords = allLines.length;

    // Deep-link: if targetSeq is set, find the line whose JSON has matching
    // seq and compute its 1-based page number. Falls back to requested page
    // if not found.
    if (targetSeq !== undefined) {
      for (let i = 0; i < allLines.length; i++) {
        try {
          const parsed = JSON.parse(allLines[i]) as { seq?: number };
          if (parsed.seq === targetSeq) {
            page = Math.floor(i / pageSize) + 1;
            break;
          }
        } catch {
          // skip malformed
        }
      }
    }

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

    return { ok: true, data: { messages, hasMore, totalRecords, page } };
  } catch (err) {
    logger.error({ err }, "Failed to fetch audit chat");
    return { ok: false, error: "Failed to fetch audit chat" };
  }
}

// ---------------------------------------------------------------------------
// 2b. getAuditUserRealInputs — flat list of a user's real text inputs across
// all their sessions, reverse-chronological. Tool_result / tool_use / images
// are stripped, leaving only the human-authored text so an admin can skim
// what the user actually asked for over time.
// ---------------------------------------------------------------------------

const MAX_SCAN_SESSIONS = 100;

export async function getAuditUserRealInputs(params: {
  userId: number;
  page: number;
  pageSize: number;
  search?: string;
}): Promise<
  ActionResult<{
    items: AuditUserRealInput[];
    hasMore: boolean;
    totalScanned: number;
  }>
> {
  const authError = await requireAdmin();
  if (authError) return authError;

  const { userId, page, pageSize, search } = params;

  try {
    // Pick the most recent N sessions belonging to the user. If a user has
    // more, we show a truncation hint client-side.
    const sessions = await db
      .select({
        sessionId: conversationAuditLog.sessionId,
        contentPath: conversationAuditLog.contentPath,
        model: conversationAuditLog.model,
      })
      .from(conversationAuditLog)
      .where(eq(conversationAuditLog.userId, userId))
      .orderBy(desc(conversationAuditLog.updatedAt))
      .limit(MAX_SCAN_SESSIONS);

    if (sessions.length === 0) {
      return { ok: true, data: { items: [], hasMore: false, totalScanned: 0 } };
    }

    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    const all: AuditUserRealInput[] = [];
    const searchLower = search?.trim().toLowerCase();

    for (const s of sessions) {
      if (!s.contentPath || !s.sessionId) continue;
      let lines: string[];
      try {
        lines = await store.readLines(s.contentPath, 0, Number.MAX_SAFE_INTEGER);
      } catch {
        continue; // missing/corrupt file — skip
      }

      for (const line of lines) {
        let parsed: AuditChatMessage;
        try {
          parsed = JSON.parse(line) as AuditChatMessage;
        } catch {
          continue;
        }

        // Support both Claude (request.messages[]) and Codex (request.input[])
        const rawMessages = Array.isArray(parsed.request?.messages)
          ? (parsed.request.messages as Array<Record<string, unknown>>)
          : [];
        const rawInput = Array.isArray(parsed.request?.input)
          ? (parsed.request.input as Array<Record<string, unknown>>)
          : [];
        const msgList = rawMessages.length > 0 ? rawMessages : rawInput;

        for (let idx = 0; idx < msgList.length; idx++) {
          const m = msgList[idx];
          const role = m.role as string | undefined;
          if (role !== "user") continue;
          const text = extractRealUserText(m.content);
          if (!text) continue;
          if (searchLower && !text.toLowerCase().includes(searchLower)) continue;
          all.push({
            sessionId: s.sessionId,
            seq: parsed.seq,
            idx,
            ts: parsed.ts,
            model: s.model,
            content: text,
          });
        }
      }
    }

    // Reverse-chronological by ts
    all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

    const offset = (page - 1) * pageSize;
    const items = all.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < all.length;

    return {
      ok: true,
      data: { items, hasMore, totalScanned: all.length },
    };
  } catch (err) {
    logger.error({ err }, "Failed to fetch user real inputs");
    return { ok: false, error: "Failed to fetch user real inputs" };
  }
}

// Some clients (Claude Code subagent rounds, slash-command harness, etc.)
// embed tool results / system reminders / command echoes as plain `text`
// blocks instead of structured tool_result blocks. Those start with these
// envelope tokens and are not human-authored input.
const SYSTEM_WRAPPER_TEXT_PATTERN =
  /^(\[Tool results\]|<(tool_result|tool_use|system-reminder|command-(name|message|args)|local-command-(stdout|stderr|caveat)|function_calls|functions)\b)/;

// Extracts just the human-authored text from a user message's content,
// ignoring tool_result / function_call_output / image blocks and the
// <image> wrapper tags Codex uses.
function extractRealUserText(content: unknown): string {
  if (typeof content === "string") {
    const t = content.trim();
    if (SYSTEM_WRAPPER_TEXT_PATTERN.test(t)) return "";
    return t;
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      const t = block.trim();
      if (!t || SYSTEM_WRAPPER_TEXT_PATTERN.test(t)) continue;
      parts.push(t);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : undefined;
    if (type === "text" || type === "input_text") {
      if (typeof b.text === "string") {
        const t = b.text.trim();
        if (/^<\/?image\b[^>]*>$/.test(t)) continue; // Codex image wrapper
        if (SYSTEM_WRAPPER_TEXT_PATTERN.test(t)) continue; // tool-result echo etc.
        if (t) parts.push(t);
      }
    }
    // Skip everything else (tool_result, tool_use, image, function_*...)
  }
  return parts.join("\n\n").trim();
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
