"use client";

import { useTranslations } from "next-intl";

type AuditSessionStatsProps = {
  totalRounds: number;
  totalTokens: number;
  totalCost: string;
  duration: string;
  model: string;
  userName: string;
};

export function AuditSessionStats({
  totalRounds,
  totalTokens,
  totalCost,
  duration,
  model,
  userName,
}: AuditSessionStatsProps) {
  const t = useTranslations("dashboard.conversationAudit.chat");

  const items = [
    { label: "User", value: userName || "-" },
    { label: "Model", value: model || "-" },
    { label: t("totalRounds"), value: String(totalRounds) },
    { label: t("totalTokens"), value: totalTokens.toLocaleString() },
    { label: t("totalCost"), value: `$${totalCost}` },
    { label: t("duration"), value: duration },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border bg-muted/30 px-4 py-2.5 text-sm">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{item.label}:</span>
          <span className="font-medium">{item.value}</span>
          {i < items.length - 1 && <span className="ml-3 text-muted-foreground/30">|</span>}
        </span>
      ))}
    </div>
  );
}
