"use client";

import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// Allow <details>, <summary>, <img> through sanitization, block unsafe tags (like SVG <path>)
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary", "img"],
  attributes: {
    ...defaultSchema.attributes,
    img: ["src", "alt", "width", "height", "style"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["data", "https"],
  },
};
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
      <div className="py-1">
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-1.5">
          <button
            type="button"
            className="w-full text-left text-xs font-medium text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {t("systemPrompt")} {expanded ? "[-]" : "[+]"}
          </button>
          {expanded && (
            <div className="mt-1.5 max-h-64 overflow-y-auto text-xs text-muted-foreground">
              <MarkdownContent content={content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const isUser = role === "user";

  return (
    <div className={cn("flex py-1", isUser ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[90%] rounded-lg px-3 py-2",
          isUser ? "rounded-bl-sm bg-blue-50 dark:bg-blue-950/40" : "rounded-br-sm bg-muted"
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {isUser ? t("userMessage") : t("assistantMessage")}
          </span>
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/60">
              {new Date(timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="prose prose-sm dark:prose-invert mt-1 max-w-none break-words">
          <MarkdownContent content={content} />
        </div>
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      components={{
        pre({ children }) {
          return (
            <pre className="overflow-x-auto rounded-md bg-black/5 p-3 text-xs dark:bg-white/5">
              {children}
            </pre>
          );
        },
        code({ children, className }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="rounded bg-black/5 px-1 py-0.5 text-xs dark:bg-white/10">
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        details({ children }) {
          return (
            <details className="my-2 rounded-md border bg-black/5 dark:bg-white/5">
              {children}
            </details>
          );
        },
        summary({ children }) {
          return (
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5">
              {children}
            </summary>
          );
        },
        img({ src, alt }) {
          return (
            <img
              src={src}
              alt={alt ?? "image"}
              className="my-2 max-h-64 max-w-full rounded-md border object-contain"
            />
          );
        },
      }}
    >
      {content}
    </Markdown>
  );
}
