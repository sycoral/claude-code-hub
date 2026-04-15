"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  const t = useTranslations("dashboard.audit.chat");

  const items = [
    { label: "User", value: userName || "-" },
    { label: "Model", value: model || "-" },
    { label: t("totalRounds"), value: String(totalRounds) },
    { label: t("totalTokens"), value: totalTokens.toLocaleString() },
    { label: t("totalCost"), value: `$${totalCost}` },
    { label: t("duration"), value: duration },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("sessionInfo")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium">{item.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
