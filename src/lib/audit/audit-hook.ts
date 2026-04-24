/**
 * Audit hook: thin entry point called after each proxy request completes.
 * Checks config and session eligibility, then delegates to the writer.
 */

import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { shouldAudit, writeAuditRecord } from "./audit-writer";

export interface AuditUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: string;
}

export const auditHook = {
  async onRequestComplete(
    session: ProxySession,
    responseText: string,
    usage?: AuditUsageInfo | null
  ): Promise<void> {
    try {
      if (!getEnvConfig().ENABLE_AUDIT) return;
      if (!shouldAudit(session)) return;
      await writeAuditRecord(session, responseText, usage ?? undefined);
    } catch (err) {
      logger.error({ err, sessionId: session.sessionId }, "Audit hook error");
    }
  },
};
