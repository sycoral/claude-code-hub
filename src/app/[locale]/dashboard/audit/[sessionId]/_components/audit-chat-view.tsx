"use client";

import { ArrowLeft } from "lucide-react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { AuditChatMessage, AuditSessionItem } from "@/actions/audit";
import { getAuditChat, getAuditSessions } from "@/actions/audit";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/routing";
import { AuditChatBubble } from "./audit-chat-bubble";
import { AuditSessionStats } from "./audit-session-stats";

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          if ("text" in block && typeof block.text === "string") return block.text;
          if ("thinking" in block && typeof block.thinking === "string")
            return `[thinking] ${block.thinking}`;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== "object") return JSON.stringify(response, null, 2);

  const resp = response as Record<string, unknown>;

  // Claude format: response.content[]
  if (Array.isArray(resp.content)) {
    return extractTextContent(resp.content);
  }

  // OpenAI format: response.choices[].message.content
  if (Array.isArray(resp.choices)) {
    const choices = resp.choices as Array<Record<string, unknown>>;
    const first = choices[0];
    if (first && typeof first === "object") {
      const msg = first.message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === "string") return msg.content;
    }
  }

  // Raw format
  if ("_raw" in resp) {
    return extractResponseText(resp._raw);
  }

  return JSON.stringify(response, null, 2);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AuditChatViewClient() {
  const t = useTranslations("dashboard.audit.chat");
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [messages, setMessages] = useState<AuditChatMessage[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [_totalRecords, setTotalRecords] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<AuditSessionItem | null>(null);

  const fetchMessages = useCallback(
    async (pageNum: number) => {
      setIsLoading(true);
      try {
        const result = await getAuditChat({ sessionId, page: pageNum, pageSize: 20 });
        if (result.ok && result.data) {
          setMessages((prev) =>
            pageNum === 1 ? result.data.messages : [...prev, ...result.data.messages]
          );
          setHasMore(result.data.hasMore);
          setTotalRecords(result.data.totalRecords);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    fetchMessages(1);
  }, [fetchMessages]);

  useEffect(() => {
    async function fetchSessionInfo() {
      const result = await getAuditSessions({ page: 1, pageSize: 1, search: sessionId });
      if (result.ok && result.data && result.data.sessions.length > 0) {
        setSessionInfo(result.data.sessions[0]);
      }
    }
    fetchSessionInfo();
  }, [sessionId]);

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchMessages(nextPage);
  };

  // Compute session stats
  const duration =
    sessionInfo?.firstAt && sessionInfo?.lastAt
      ? formatDuration(
          new Date(sessionInfo.lastAt).getTime() - new Date(sessionInfo.firstAt).getTime()
        )
      : "-";

  return (
    <div className="flex gap-6">
      {/* Main chat area */}
      <div className="min-w-0 flex-1 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/dashboard/audit">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{sessionId.slice(0, 16)}...</p>
          </div>
        </div>

        {/* Messages */}
        <div className="space-y-1">
          {hasMore && (
            <div className="flex justify-center py-2">
              <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={isLoading}>
                {t("loadMore")}
              </Button>
            </div>
          )}

          {messages.length === 0 && !isLoading && (
            <div className="py-12 text-center text-muted-foreground">{t("noData")}</div>
          )}

          {messages.map((msg) => {
            const bubbles: React.ReactNode[] = [];

            // System prompt (first message)
            if (msg.seq === 1 && msg.request.system) {
              bubbles.push(
                <AuditChatBubble
                  key={`${msg.seq}-system`}
                  role="system"
                  content={extractTextContent(msg.request.system)}
                  timestamp={msg.ts}
                />
              );
            }

            // User messages from request.messages
            if (Array.isArray(msg.request.messages)) {
              const userMsgs = (msg.request.messages as Array<Record<string, unknown>>).filter(
                (m) => m.role === "user"
              );
              for (const [idx, userMsg] of userMsgs.entries()) {
                bubbles.push(
                  <AuditChatBubble
                    key={`${msg.seq}-user-${idx}`}
                    role="user"
                    content={extractTextContent(userMsg.content)}
                    timestamp={msg.ts}
                  />
                );
              }
            }

            // Assistant response
            if (msg.response) {
              bubbles.push(
                <AuditChatBubble
                  key={`${msg.seq}-assistant`}
                  role="assistant"
                  content={extractResponseText(msg.response)}
                  timestamp={msg.ts}
                  tokens={msg._meta?.size}
                />
              );
            }

            return bubbles;
          })}
        </div>
      </div>

      {/* Stats sidebar */}
      <div className="hidden w-72 shrink-0 lg:block">
        {sessionInfo && (
          <AuditSessionStats
            totalRounds={sessionInfo.requestCount}
            totalTokens={sessionInfo.totalInputTokens + sessionInfo.totalOutputTokens}
            totalCost={sessionInfo.totalCost}
            duration={duration}
            model={sessionInfo.model ?? "-"}
            userName={sessionInfo.userName ?? "-"}
          />
        )}
      </div>
    </div>
  );
}
