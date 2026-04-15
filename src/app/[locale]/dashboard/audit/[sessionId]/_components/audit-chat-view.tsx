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
          const b = block as Record<string, unknown>;
          // Normal text
          if (b.type === "text" && typeof b.text === "string") return b.text;
          // Thinking
          if (b.type === "thinking" && typeof b.thinking === "string")
            return `<details><summary>thinking</summary>\n\n${b.thinking}\n\n</details>`;
          // Tool use
          if (b.type === "tool_use") {
            const name = b.name ?? "unknown";
            const input = typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2);
            return `<details><summary>tool_use: ${name}</summary>\n\n\`\`\`json\n${input}\n\`\`\`\n\n</details>`;
          }
          // Tool result
          if (b.type === "tool_result") {
            const inner = Array.isArray(b.content)
              ? (b.content as unknown[])
                  .map((c) => {
                    if (typeof c === "string") return c;
                    if (c && typeof c === "object" && "text" in c) return (c as Record<string, unknown>).text;
                    return JSON.stringify(c);
                  })
                  .join("\n")
              : typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content, null, 2);
            const preview = typeof inner === "string" && inner.length > 100 ? `${inner.slice(0, 100)}...` : inner;
            return `<details><summary>tool_result: ${preview}</summary>\n\n${inner}\n\n</details>`;
          }
          // Image
          if (b.type === "image" || b.type === "image_url") {
            return "[Image]";
          }
          // Fallback for known text field
          if ("text" in b && typeof b.text === "string") return b.text;
        }
        return JSON.stringify(block);
      })
      .join("\n\n");
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
    <div className="space-y-3">
      {/* Header + Stats bar */}
      <div className="sticky top-16 z-10 space-y-2 bg-background pb-2">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/audit">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold">{t("title")}</h1>
            <p className="font-mono text-xs text-muted-foreground">{sessionId}</p>
          </div>
        </div>
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

      {/* Messages */}
      <div className="space-y-0.5">
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

            // Messages are stored incrementally: only the new interaction for this turn
            const msgList = Array.isArray(msg.request.messages)
              ? (msg.request.messages as Array<Record<string, unknown>>)
              : [];

            // System prompt (only present in seq 1)
            if (msg.request.system) {
              bubbles.push(
                <AuditChatBubble
                  key={`${msg.seq}-system`}
                  role="system"
                  content={extractTextContent(msg.request.system)}
                  timestamp={msg.ts}
                />
              );
            }

            // Render all stored messages (already extracted as new-only by backend)
            for (const [idx, m] of msgList.entries()) {
              const role = m.role as string;
              if (role === "user" || role === "assistant") {
                bubbles.push(
                  <AuditChatBubble
                    key={`${msg.seq}-${role}-${idx}`}
                    role={role as "user" | "assistant"}
                    content={extractTextContent(m.content)}
                    timestamp={msg.ts}
                  />
                );
              }
            }

            // The actual new response for this seq
            if (msg.response) {
              const respText = extractResponseText(msg.response);
              if (respText) {
                bubbles.push(
                  <AuditChatBubble
                    key={`${msg.seq}-response`}
                    role="assistant"
                    content={respText}
                    timestamp={msg.ts}
                  />
                );
              }
            }

            return bubbles;
          })}
        </div>
    </div>
  );
}
