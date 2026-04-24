"use client";

import { ArrowLeft, ListChecks } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditChatMessage, AuditSessionItem } from "@/actions/audit";
import { getAuditChat, getAuditSessions } from "@/actions/audit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Link } from "@/i18n/routing";
import { AuditChatBubble } from "./audit-chat-bubble";
import { AuditSessionStats } from "./audit-session-stats";

// Block types considered "tool-related" — hidden when `onlyRealInput` is on.
const TOOL_BLOCK_TYPES = new Set([
  "tool_use",
  "tool_result",
  "function_call",
  "function_call_output",
]);

type ExtractOpts = { hideToolBlocks?: boolean };

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown, opts: ExtractOpts = {}): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          // Hide tool-related blocks when the "real input only" filter is on.
          if (opts.hideToolBlocks && typeof b.type === "string" && TOOL_BLOCK_TYPES.has(b.type)) {
            return "";
          }
          // Normal text (Claude)
          if (b.type === "text" && typeof b.text === "string") return b.text;
          // Input text (Codex/OpenAI Response API)
          // Skip <image> / </image> wrapper tags (Codex wraps images with these)
          if (b.type === "input_text" && typeof b.text === "string") {
            const trimmed = b.text.trim();
            if (/^<\/?image\b[^>]*>$/.test(trimmed)) return "";
            return b.text;
          }
          // Input image (Codex) — use special marker that will be rendered as React component
          if (b.type === "input_image" && typeof b.image_url === "string") {
            const url = b.image_url as string;
            if (url.startsWith("data:") && url.length > 100) {
              return `\n\n[AUDIT_IMAGE:${url}]\n\n`;
            }
            return "[Image]";
          }
          // Output text (Codex response)
          if (b.type === "output_text" && typeof b.text === "string") return b.text;
          // Thinking (Claude)
          if (b.type === "thinking" && typeof b.thinking === "string")
            return `<details><summary>thinking</summary>\n\n${b.thinking}\n\n</details>`;
          // Reasoning (Codex)
          if (b.type === "reasoning" && typeof b.text === "string")
            return `<details><summary>reasoning</summary>\n\n${b.text}\n\n</details>`;
          // Tool use (Claude)
          if (b.type === "tool_use") {
            const name = b.name ?? "unknown";
            const input = typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2);
            return `<details><summary>tool_use: ${name}</summary>\n\n\`\`\`json\n${input}\n\`\`\`\n\n</details>`;
          }
          // Function call (Codex)
          if (b.type === "function_call") {
            const name = b.name ?? "unknown";
            const args =
              typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments, null, 2);
            return `<details><summary>function_call: ${name}</summary>\n\n\`\`\`json\n${args}\n\`\`\`\n\n</details>`;
          }
          // Tool result (Claude)
          if (b.type === "tool_result") {
            const inner = Array.isArray(b.content)
              ? (b.content as unknown[])
                  .map((c) => {
                    if (typeof c === "string") return c;
                    if (c && typeof c === "object" && "text" in c)
                      return (c as Record<string, unknown>).text;
                    return JSON.stringify(c);
                  })
                  .join("\n")
              : typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content, null, 2);
            const preview =
              typeof inner === "string" && inner.length > 100 ? `${inner.slice(0, 100)}...` : inner;
            return `<details><summary>tool_result: ${preview}</summary>\n\n${inner}\n\n</details>`;
          }
          // Function call output (Codex)
          if (b.type === "function_call_output") {
            const output =
              typeof b.output === "string" ? b.output : JSON.stringify(b.output, null, 2);
            const preview = output.length > 100 ? `${output.slice(0, 100)}...` : output;
            return `<details><summary>function_output: ${preview}</summary>\n\n${output}\n\n</details>`;
          }
          // Image (Claude: type=image with source.data, Codex: type=input_image with image_url)
          if (b.type === "image" && typeof b.source === "object" && b.source) {
            const src = b.source as Record<string, unknown>;
            if (typeof src.data === "string" && src.data.length > 100) {
              const mediaType = (src.media_type as string) || "image/png";
              return `\n\n[AUDIT_IMAGE:data:${mediaType};base64,${src.data}]\n\n`;
            }
            return "[Image]";
          }
          // input_image handled above (near input_text), skip duplicate
          if (b.type === "image_url") {
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

function extractResponseText(response: unknown, opts: ExtractOpts = {}): string {
  if (!response || typeof response !== "object") return JSON.stringify(response, null, 2);

  const resp = response as Record<string, unknown>;

  // Claude format: response.content[]
  if (Array.isArray(resp.content) && resp.content.length > 0) {
    return extractTextContent(resp.content, opts);
  }

  // Codex format: response.output[]
  if (Array.isArray(resp.output)) {
    return extractTextContent(resp.output, opts);
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
    return extractResponseText(resp._raw, opts);
  }

  return JSON.stringify(response, null, 2);
}

const ONLY_REAL_INPUT_KEY = "audit.only-real-input";

// Parse deep-link anchor param "seq:idx" from URL search. Returns null on bad
// input so ?at= is gracefully ignored instead of crashing.
function parseAtParam(raw: string | null): { seq: number; idx: number } | null {
  if (!raw) return null;
  const [seqStr, idxStr] = raw.split(":");
  const seq = Number(seqStr);
  const idx = Number(idxStr);
  if (!Number.isFinite(seq) || !Number.isFinite(idx)) return null;
  return { seq, idx };
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
  const t = useTranslations("dashboard.conversationAudit.chat");
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const searchParams = useSearchParams();

  // Deep-link: `?at=<seq>:<idx>` — remember the target, scroll after render.
  const atParam = searchParams.get("at");
  const target = parseAtParam(atParam);

  const PAGE_SIZE = 20;
  const [messages, setMessages] = useState<AuditChatMessage[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalRecords, setTotalRecords] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<AuditSessionItem | null>(null);
  const [onlyRealInput, setOnlyRealInput] = useState(false);
  const [highlightSeqIdx, setHighlightSeqIdx] = useState<string | null>(null);
  const hasScrolledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Restore toggle from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOnlyRealInput(window.localStorage.getItem(ONLY_REAL_INPUT_KEY) === "1");
  }, []);

  const handleToggleRealInput = useCallback((next: boolean) => {
    setOnlyRealInput(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ONLY_REAL_INPUT_KEY, next ? "1" : "0");
    }
  }, []);

  const fetchMessages = useCallback(
    async (pageNum: number, opts?: { targetSeq?: number }) => {
      // Cancel previous in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      try {
        const result = await getAuditChat({
          sessionId,
          page: pageNum,
          pageSize: PAGE_SIZE,
          targetSeq: opts?.targetSeq,
        });
        if (controller.signal.aborted) return;
        if (result.ok && result.data) {
          setMessages(result.data.messages); // Replace, not append
          setHasMore(result.data.hasMore);
          setTotalRecords(result.data.totalRecords);
          setPage(result.data.page);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [sessionId]
  );

  useEffect(() => {
    // Initial load: jump straight to the page containing the target seq
    // if we got one via ?at=. Otherwise page 1.
    fetchMessages(1, target ? { targetSeq: target.seq } : undefined);
    return () => abortRef.current?.abort();
  }, [fetchMessages, target?.seq]);

  // Scroll & highlight the deep-link target bubble once it's rendered.
  useEffect(() => {
    if (!target || hasScrolledRef.current || isLoading || messages.length === 0) return;
    const id = `msg-${target.seq}-${target.idx}`;
    const el = document.getElementById(id);
    if (!el) return;
    hasScrolledRef.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightSeqIdx(`${target.seq}:${target.idx}`);
    const timer = window.setTimeout(() => setHighlightSeqIdx(null), 2500);
    return () => window.clearTimeout(timer);
  }, [target, isLoading, messages]);

  useEffect(() => {
    let cancelled = false;
    async function fetchSessionInfo() {
      const result = await getAuditSessions({ page: 1, pageSize: 1, search: sessionId });
      if (cancelled) return;
      if (result.ok && result.data && result.data.sessions.length > 0) {
        setSessionInfo(result.data.sessions[0]);
      }
    }
    fetchSessionInfo();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);
  const handlePrevPage = () => fetchMessages(page - 1);
  const handleNextPage = () => fetchMessages(page + 1);

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
          <div className="flex-1">
            <h1 className="text-xl font-bold">{t("title")}</h1>
            <p className="font-mono text-xs text-muted-foreground">{sessionId}</p>
          </div>
          {sessionInfo?.userId && (
            <Link href={`/dashboard/audit/user/${sessionInfo.userId}`}>
              <Button variant="secondary" size="sm" className="gap-1">
                <ListChecks className="h-3.5 w-3.5" />
                {t("viewUserInputs")}
              </Button>
            </Link>
          )}
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
        <div className="flex items-center justify-end gap-2">
          <Switch
            id="audit-only-real-input"
            checked={onlyRealInput}
            onCheckedChange={handleToggleRealInput}
          />
          <Label htmlFor="audit-only-real-input" className="cursor-pointer text-xs">
            {t("onlyRealInput")}
          </Label>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-0.5">
        {messages.length === 0 && !isLoading && (
          <div className="py-12 text-center text-muted-foreground">{t("noData")}</div>
        )}

        {messages.map((msg) => {
          const bubbles: React.ReactNode[] = [];
          const extractOpts: ExtractOpts = { hideToolBlocks: onlyRealInput };

          // Support both Claude (messages[]) and Codex (input[]) formats
          const rawMessages = Array.isArray(msg.request.messages)
            ? (msg.request.messages as Array<Record<string, unknown>>)
            : [];
          const rawInput = Array.isArray(msg.request.input)
            ? (msg.request.input as Array<Record<string, unknown>>)
            : [];
          const msgList = rawMessages.length > 0 ? rawMessages : rawInput;

          // System prompt (Claude) or instructions (Codex) — only present in seq 1
          const systemContent = msg.request.system ?? msg.request.instructions;
          if (systemContent) {
            const content = extractTextContent(systemContent, extractOpts);
            if (content.trim()) {
              bubbles.push(
                <AuditChatBubble
                  key={`${msg.seq}-system`}
                  role="system"
                  content={content}
                  timestamp={msg.ts}
                />
              );
            }
          }

          // Render all stored messages (already extracted as new-only by backend)
          // Map roles: Claude (user/assistant) + Codex (user/developer/assistant + type-based items)
          for (const [idx, m] of msgList.entries()) {
            const role = m.role as string;
            const type = m.type as string;

            // Codex function_call / function_call_output — show as tool interaction
            if (type === "function_call" || type === "function_call_output") {
              const content = extractTextContent(
                type === "function_call"
                  ? [{ type: "function_call", name: m.name, arguments: m.arguments }]
                  : [{ type: "function_call_output", output: m.output }],
                extractOpts
              );
              if (content.trim()) {
                bubbles.push(
                  <AuditChatBubble
                    key={`${msg.seq}-tool-${idx}`}
                    role={type === "function_call" ? "assistant" : "user"}
                    content={content}
                    timestamp={msg.ts}
                  />
                );
              }
              continue;
            }

            if (role === "user" || role === "assistant") {
              const content = extractTextContent(m.content, extractOpts);
              if (content.trim()) {
                const bubbleId = `msg-${msg.seq}-${idx}`;
                bubbles.push(
                  <AuditChatBubble
                    key={`${msg.seq}-${role}-${idx}`}
                    role={role as "user" | "assistant"}
                    content={content}
                    timestamp={msg.ts}
                    domId={bubbleId}
                    highlighted={highlightSeqIdx === `${msg.seq}:${idx}`}
                  />
                );
              }
            }
          }

          // The actual new response for this seq
          if (msg.response) {
            const respText = extractResponseText(msg.response, extractOpts);
            if (respText.trim()) {
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

        {/* Pagination at bottom */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 py-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevPage}
              disabled={page <= 1 || isLoading}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNextPage}
              disabled={!hasMore || isLoading}
            >
              {t("loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
