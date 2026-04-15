/**
 * Audit writer: persists request/response pairs to JSONL files and database.
 * Audit failures are caught and logged -- they must NEVER break the proxy.
 */

import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { auditLog } from "@/drizzle/audit-schema";
import { db } from "@/drizzle/db";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { isSSEText, parseSSEData } from "@/lib/utils/sse";
import { AuditFileStore } from "./audit-file-store";
import { extractSummary, preprocessAuditContent } from "./audit-preprocessor";

const TWO_MB = 2 * 1024 * 1024;

/**
 * Returns true when a session should be audited:
 * - provider was selected (not null, id > 0)
 * - messageContext exists (has a DB record)
 */
export function shouldAudit(session: ProxySession): boolean {
  if (session.provider == null || session.provider.id <= 0) return false;
  if (session.messageContext == null) return false;
  return true;
}

/**
 * Orchestrates writing a full audit record (JSONL file + DB row).
 * All errors are caught and logged -- audit must never break the proxy.
 */
export async function writeAuditRecord(
  session: ProxySession,
  responseText: string,
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: string }
): Promise<void> {
  try {
    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    // 1. Parse response: JSON directly, or reassemble from SSE events
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      if (isSSEText(responseText)) {
        responseBody = reassembleSSEResponse(responseText);
      } else {
        responseBody = { _raw: responseText.slice(0, config.AUDIT_CONTENT_MAX_SIZE) };
      }
    }

    // 2. Extract the new user interaction from this turn (stateless, no counter)
    const allMessages = Array.isArray(session.request.message.messages)
      ? (session.request.message.messages as Array<Record<string, unknown>>)
      : [];
    const newMessages = extractNewMessages(allMessages);

    const incrementalRequest: Record<string, unknown> = {
      ...session.request.message,
      messages: newMessages,
    };

    // Only include system prompt for the first request in a session
    if (session.requestSequence > 1) {
      delete incrementalRequest.system;
    }

    // 3. Preprocess content (strip images, truncate)
    const processed = preprocessAuditContent(
      incrementalRequest,
      responseBody,
      config.AUDIT_CONTENT_MAX_SIZE
    );

    // 4. Build JSONL line
    const lineObj = {
      seq: session.requestSequence,
      ts: new Date().toISOString(),
      request: processed.request,
      response: processed.response,
      context: {
        totalMessages: allMessages.length,
        system: session.requestSequence === 1 && !!session.request.message.system,
      },
      _meta: {
        size: processed.originalSize,
        truncated: processed.truncated,
      },
    };
    const line = JSON.stringify(lineObj);

    // 5. Append to file; compress if line > 2MB
    const sessionFileId = session.sessionId ?? `no-session-${session.messageContext!.id}`;
    let contentPath = await store.appendLine(sessionFileId, line);
    let compressed = false;
    if (Buffer.byteLength(line, "utf-8") > TWO_MB) {
      contentPath = await store.compressFile(contentPath);
      compressed = true;
    }

    // 6. Extract summary for DB (from the last user message)
    const summary = extractSummary(session.request.message, 500);

    // 7. Insert DB row
    await db.insert(auditLog).values({
      requestId: session.messageContext!.id,
      userId: session.authState?.user?.id ?? 0,
      userName: session.authState?.user?.name ?? session.userName,
      key: session.authState?.apiKey ?? "",
      sessionId: session.sessionId,
      requestSeq: session.requestSequence,
      model: session.request.model,
      endpoint: session.getEndpoint(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costUsd: usage?.costUsd ?? "0",
      totalMessages: allMessages.length,
      contentSummary: summary || null,
      contentPath,
      contentSize: processed.originalSize,
      compressed,
    });

    logger.debug(
      { sessionId: session.sessionId, seq: session.requestSequence, contentPath },
      "Audit record written"
    );
  } catch (err) {
    logger.error({ err, sessionId: session.sessionId }, "Failed to write audit record");
  }
}

/**
 * Extract the "new messages" from the current turn.
 *
 * Stateless: does not depend on any counter, DB query, or prior state.
 * Works regardless of whether messages array grew, shrank, or stayed the same.
 *
 * Logic:
 * - If the last message is a regular user message (text): return just that message.
 * - If the last message is a tool_result user message: return the immediately preceding
 *   assistant(tool_use) + this user(tool_result) pair (one tool call round).
 * - Otherwise: return the last message as-is.
 *
 * This captures exactly one interaction unit per seq, never scanning further back
 * into the history.
 */
export function extractNewMessages(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [];

  const lastMsg = messages[messages.length - 1];

  // Case 1: last message is a user message
  if (lastMsg.role === "user") {
    // If it's a tool_result, include the preceding assistant(tool_use) as context
    if (isToolResultMessage(lastMsg) && messages.length >= 2) {
      const prevMsg = messages[messages.length - 2];
      if (prevMsg.role === "assistant" && isToolUseMessage(prevMsg)) {
        return [prevMsg, lastMsg];
      }
    }
    // Regular user message or standalone tool_result
    return [lastMsg];
  }

  // Case 2: last message is something else (shouldn't normally happen)
  return [lastMsg];
}

/**
 * Check if a user message is a tool_result (not a real user input).
 */
function isToolResultMessage(msg: Record<string, unknown>): boolean {
  if (msg.role !== "user") return false;
  const content = msg.content;
  if (Array.isArray(content)) {
    return content.some(
      (block) => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "tool_result"
    );
  }
  return false;
}

/**
 * Check if an assistant message contains tool_use blocks.
 */
function isToolUseMessage(msg: Record<string, unknown>): boolean {
  if (msg.role !== "assistant") return false;
  const content = msg.content;
  if (Array.isArray(content)) {
    return content.some(
      (block) => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "tool_use"
    );
  }
  return false;
}

/**
 * Reassemble a complete response object from SSE stream text.
 *
 * Handles Claude, OpenAI, and Codex streaming formats:
 * - Claude: event types content_block_delta (text/thinking), message_start, message_delta
 * - OpenAI: choices[].delta.content chunks
 *
 * Returns a clean object with the final assembled content.
 */
function reassembleSSEResponse(sseText: string): unknown {
  const events = parseSSEData(sseText);
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  let model: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let stopReason: string | undefined;

  for (const evt of events) {
    if (typeof evt.data === "string") continue; // skip [DONE] etc.
    const data = evt.data as Record<string, unknown>;

    // Claude format
    if (evt.event === "message_start" && typeof data.message === "object" && data.message) {
      const msg = data.message as Record<string, unknown>;
      model = model ?? (msg.model as string);
    }
    if (evt.event === "content_block_delta" && typeof data.delta === "object" && data.delta) {
      const delta = data.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        textParts.push(delta.text);
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        thinkingParts.push(delta.thinking);
      }
    }
    if (evt.event === "message_delta" && typeof data.delta === "object" && data.delta) {
      const delta = data.delta as Record<string, unknown>;
      stopReason = stopReason ?? (delta.stop_reason as string);
    }
    if (evt.event === "message_delta" && typeof data.usage === "object" && data.usage) {
      usage = data.usage as Record<string, unknown>;
    }

    // OpenAI format (no event name, data has choices[].delta)
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices as Record<string, unknown>[]) {
        if (typeof choice.delta === "object" && choice.delta) {
          const delta = choice.delta as Record<string, unknown>;
          if (typeof delta.content === "string") {
            textParts.push(delta.content);
          }
        }
      }
      model = model ?? (data.model as string);
    }
  }

  const result: Record<string, unknown> = {};
  if (model) result.model = model;
  if (stopReason) result.stop_reason = stopReason;

  const content: Record<string, unknown>[] = [];
  if (thinkingParts.length > 0) {
    content.push({ type: "thinking", thinking: thinkingParts.join("") });
  }
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("") });
  }
  result.content = content;

  if (usage) result.usage = usage;

  return result;
}
