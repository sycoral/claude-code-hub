"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/lib/utils";

type AuditChatBubbleProps = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  tokens?: number;
};

export function AuditChatBubble({ role, content, timestamp, tokens }: AuditChatBubbleProps) {
  const t = useTranslations("dashboard.audit.chat");
  const [expanded, setExpanded] = useState(false);

  if (role === "system") {
    return (
      <div className="flex justify-center py-2">
        <div className="w-full max-w-2xl rounded-md border border-dashed bg-muted/50 p-3">
          <button
            type="button"
            className="w-full text-left text-sm font-medium text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {t("systemPrompt")} {expanded ? "[-]" : "[+]"}
          </button>
          {expanded && (
            <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{content}</div>
          )}
        </div>
      </div>
    );
  }

  const isUser = role === "user";

  return (
    <div className={cn("flex py-2", isUser ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[80%] rounded-xl px-4 py-3",
          isUser ? "rounded-bl-md bg-blue-50 dark:bg-blue-950/40" : "rounded-br-md bg-muted"
        )}
      >
        <div className="mb-1 text-xs font-semibold text-muted-foreground">
          {isUser ? t("userMessage") : t("assistantMessage")}
        </div>
        <div className="whitespace-pre-wrap text-sm">{content}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {timestamp && <span>{new Date(timestamp).toLocaleString()}</span>}
          {tokens != null && tokens > 0 && (
            <span>
              {tokens} {t("tokens")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
