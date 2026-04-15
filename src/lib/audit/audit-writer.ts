/**
 * Audit writer: persists request/response pairs to JSONL files and database.
 * Audit failures are caught and logged -- they must NEVER break the proxy.
 */

import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { auditLog } from "@/drizzle/audit-schema";
import { db } from "@/drizzle/db";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
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
export async function writeAuditRecord(session: ProxySession, responseText: string): Promise<void> {
  try {
    const config = getEnvConfig();
    const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);

    // 1. Parse response as JSON, fall back to raw text wrapper
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { _raw: responseText.slice(0, config.AUDIT_CONTENT_MAX_SIZE) };
    }

    // 2. Preprocess content (strip images, truncate)
    const processed = preprocessAuditContent(
      session.request.message,
      responseBody,
      config.AUDIT_CONTENT_MAX_SIZE
    );

    // 3. Build JSONL line
    const lineObj = {
      seq: session.requestSequence,
      ts: new Date().toISOString(),
      request: processed.request,
      response: processed.response,
      _meta: {
        size: processed.originalSize,
        truncated: processed.truncated,
      },
    };
    const line = JSON.stringify(lineObj);

    // 4. Append to file; compress if line > 2MB
    const sessionFileId = session.sessionId ?? `no-session-${session.messageContext!.id}`;
    let contentPath = await store.appendLine(sessionFileId, line);
    let compressed = false;
    if (Buffer.byteLength(line, "utf-8") > TWO_MB) {
      contentPath = await store.compressFile(contentPath);
      compressed = true;
    }

    // 5. Extract summary for DB
    const summary = extractSummary(session.request.message, 500);

    // 6. Insert DB row
    await db.insert(auditLog).values({
      requestId: session.messageContext!.id,
      userId: session.authState?.user?.id ?? 0,
      userName: session.authState?.user?.name ?? session.userName,
      key: session.authState?.apiKey ?? "",
      sessionId: session.sessionId,
      requestSeq: session.requestSequence,
      model: session.request.model,
      endpoint: session.getEndpoint(),
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
