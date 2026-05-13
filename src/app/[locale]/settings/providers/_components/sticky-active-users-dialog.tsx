"use client";

import { Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  evictStickyUser,
  listStickyActiveUsers,
  type StickyActiveUser,
} from "@/actions/provider-groups";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTokenAmount } from "@/lib/utils/token";

function tierBadgeClass(tier: StickyActiveUser["loadTier"]): string {
  switch (tier) {
    case "heavy":
      return "bg-destructive/10 text-destructive border border-destructive/30";
    case "medium":
      return "bg-amber-500/10 text-amber-700 border border-amber-500/30 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground border border-border";
  }
}

function tierLabel(
  tier: StickyActiveUser["loadTier"],
  t: ReturnType<typeof useTranslations>
): string {
  switch (tier) {
    case "heavy":
      return t("weightHeavy");
    case "medium":
      return t("weightMedium");
    default:
      return t("weightNormal");
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  providerId: number;
  providerName: string;
  cap: number | null;
  onChanged: () => void;
}

function formatRemaining(expireAtMs: number, t: ReturnType<typeof useTranslations>): string {
  const ms = expireAtMs - Date.now();
  if (ms <= 0) return t("expired");
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return t("remainingHm", { hours, minutes });
  }
  if (minutes > 0) {
    return t("remainingMinutes", { minutes });
  }
  return t("remainingSeconds", { seconds: totalSec });
}

export function StickyActiveUsersDialog({
  open,
  onOpenChange,
  groupName,
  providerId,
  providerName,
  cap,
  onChanged,
}: Props) {
  const t = useTranslations("settings.providers.providerGroups.advanced.activeUsers");
  const [items, setItems] = useState<StickyActiveUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [evictingUid, setEvictingUid] = useState<number | null>(null);
  const [confirmUid, setConfirmUid] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listStickyActiveUsers(groupName, providerId);
      if (res.ok) {
        setItems(res.data);
      } else {
        toast.error(res.error);
      }
    } finally {
      setLoading(false);
    }
  }, [groupName, providerId]);

  useEffect(() => {
    if (open) {
      void refresh();
      setConfirmUid(null);
    }
  }, [open, refresh]);

  const handleEvict = useCallback(
    async (uid: number) => {
      setEvictingUid(uid);
      try {
        const res = await evictStickyUser(groupName, providerId, uid);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(t("evictSuccess"));
        setConfirmUid(null);
        await refresh();
        onChanged();
      } finally {
        setEvictingUid(null);
      }
    },
    [groupName, providerId, refresh, onChanged, t]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { provider: providerName })}</DialogTitle>
          <DialogDescription>
            {t("dialogDesc", {
              group: groupName,
              count: items.length,
              cap: cap == null ? t("noCap") : String(cap),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colUser")}</TableHead>
                  <TableHead className="w-[110px]">{t("colWeight")}</TableHead>
                  <TableHead className="w-[160px]">{t("colRemaining")}</TableHead>
                  <TableHead className="w-[120px] text-right">{t("colAction")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const isConfirming = confirmUid === item.uid;
                  const isEvicting = evictingUid === item.uid;
                  return (
                    <TableRow key={item.uid}>
                      <TableCell>
                        <div className="font-medium">{item.name ?? `#${item.uid}`}</div>
                        <div className="text-xs text-muted-foreground">uid {item.uid}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {item.rank != null
                            ? t("usageLine", {
                                tokens: formatTokenAmount(item.weeklyTokens),
                                rank: item.rank,
                                total: item.rankTotal,
                              })
                            : t("usageLineNone")}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tierBadgeClass(
                            item.loadTier
                          )}`}
                          title={t("weightTooltip")}
                        >
                          {tierLabel(item.loadTier, t)}
                          <span className="ml-1 tabular-nums opacity-70">×{item.loadWeight}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {formatRemaining(item.expireAtMs, t)}
                      </TableCell>
                      <TableCell className="text-right">
                        {isConfirming ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={isEvicting}
                              onClick={() => handleEvict(item.uid)}
                            >
                              {isEvicting ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              {t("confirmEvict")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmUid(null)}
                              disabled={isEvicting}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmUid(item.uid)}
                          >
                            {t("evict")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
