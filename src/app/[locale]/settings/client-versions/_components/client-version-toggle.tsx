"use client";

import { AlertCircle, Lock, Shield, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveSystemSettings } from "@/actions/system-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SettingsToggleRow } from "../../_components/ui/settings-ui";

const PINNED_CLIENT_TYPES = [
  "claude-cli",
  "claude-vscode",
  "claude-cli-unknown",
  "anthropic-sdk-typescript",
] as const;

interface ClientVersionToggleProps {
  enabled: boolean;
  pinned: Record<string, string>;
}

export function ClientVersionToggle({ enabled, pinned }: ClientVersionToggleProps) {
  const t = useTranslations("settings.clientVersions");
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [pinnedDraft, setPinnedDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const clientType of PINNED_CLIENT_TYPES) {
      initial[clientType] = pinned[clientType] ?? "";
    }
    return initial;
  });
  const [isPending, startTransition] = useTransition();
  const [isSavingPinned, startPinnedTransition] = useTransition();

  async function handleToggle(checked: boolean) {
    startTransition(async () => {
      const result = await saveSystemSettings({
        enableClientVersionCheck: checked,
      });

      if (result.ok) {
        setIsEnabled(checked);
        toast.success(checked ? t("toggle.enableSuccess") : t("toggle.disableSuccess"));
      } else {
        toast.error(result.error || t("toggle.toggleFailed"));
      }
    });
  }

  function handlePinnedChange(clientType: string, value: string) {
    setPinnedDraft((prev) => ({ ...prev, [clientType]: value }));
  }

  async function handleSavePinned() {
    startPinnedTransition(async () => {
      const sanitized: Record<string, string> = {};
      for (const [clientType, value] of Object.entries(pinnedDraft)) {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          sanitized[clientType] = trimmed;
        }
      }

      const result = await saveSystemSettings({ clientVersionPinned: sanitized });

      if (result.ok) {
        toast.success(t("pinned.saveSuccess"));
      } else {
        toast.error(result.error || t("pinned.saveFailed"));
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Toggle Row */}
      <SettingsToggleRow
        title={t("toggle.enable")}
        description={t("toggle.description")}
        icon={isEnabled ? ShieldCheck : Shield}
        iconBgColor={isEnabled ? "bg-[#E25706]/10" : "bg-muted/50"}
        iconColor={isEnabled ? "text-[#E25706]" : "text-muted-foreground"}
        checked={isEnabled}
        onCheckedChange={handleToggle}
        disabled={isPending}
      />

      {/* Pinned versions section (only show when enabled) */}
      {isEnabled && (
        <div className="p-4 rounded-xl border bg-white/[0.02] border-white/5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg shrink-0 bg-[#E25706]/10">
              <Lock className="h-4 w-4 text-[#E25706]" />
            </div>
            <div className="space-y-3 min-w-0 flex-1">
              <div>
                <p className="text-sm font-medium text-foreground">{t("pinned.title")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("pinned.description")}</p>
              </div>
              <div className="space-y-2">
                {PINNED_CLIENT_TYPES.map((clientType) => (
                  <div key={clientType} className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <Label
                      htmlFor={`pinned-${clientType}`}
                      className="text-xs text-muted-foreground sm:w-56 sm:shrink-0"
                    >
                      {clientType}
                    </Label>
                    <Input
                      id={`pinned-${clientType}`}
                      type="text"
                      placeholder={t("pinned.placeholder")}
                      value={pinnedDraft[clientType] ?? ""}
                      onChange={(e) => handlePinnedChange(clientType, e.target.value)}
                      disabled={isSavingPinned}
                      className="h-8 text-xs"
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSavePinned}
                  disabled={isSavingPinned}
                >
                  {t("pinned.save")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Feature Alert */}
      <div
        className={cn(
          "p-4 rounded-xl border transition-colors",
          isEnabled ? "bg-[#E25706]/5 border-[#E25706]/20" : "bg-white/[0.02] border-white/5"
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn("p-2 rounded-lg shrink-0", isEnabled ? "bg-[#E25706]/10" : "bg-white/5")}
          >
            <AlertCircle
              className={cn("h-4 w-4", isEnabled ? "text-[#E25706]" : "text-muted-foreground")}
            />
          </div>
          <div className="space-y-3 min-w-0">
            <p className="text-sm font-medium text-foreground">{t("features.title")}</p>
            <div className="text-xs text-muted-foreground space-y-2">
              <p className="font-medium">{t("features.whatHappens")}</p>
              <ul className="list-inside list-disc space-y-1 ml-1">
                <li>{t("features.autoDetect")}</li>
                <li>
                  <span className="font-medium">{t("features.gaRule")}</span>
                  {t("features.gaRuleDesc")}
                </li>
                <li>
                  <span className="font-medium">{t("features.activeWindow")}</span>
                  {t("features.activeWindowDesc")}
                </li>
                <li className={isEnabled ? "text-[#E25706] font-medium" : ""}>
                  {t("features.blockOldVersion")}
                </li>
                <li>{t("features.errorMessage")}</li>
              </ul>

              <div className="mt-3 pt-3 border-t border-white/5">
                <span className="font-medium">{t("features.recommendation")}</span>
                <span className="ml-1">{t("features.recommendationDesc")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
