"use client";

import { ArrowLeft, MessageSquare, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditUserRealInput, getAuditUserRealInputs } from "@/actions/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/routing";

const PAGE_SIZE = 30;

export function UserRealInputsClient({ userId }: { userId: number }) {
  const t = useTranslations("dashboard.conversationAudit.userView");
  const [items, setItems] = useState<AuditUserRealInput[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalScanned, setTotalScanned] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const fetchInputs = useCallback(
    async (pageNum: number, search: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      try {
        const result = await getAuditUserRealInputs({
          userId,
          page: pageNum,
          pageSize: PAGE_SIZE,
          search: search || undefined,
        });
        if (controller.signal.aborted) return;
        if (result.ok && result.data) {
          setItems(result.data.items);
          setHasMore(result.data.hasMore);
          setTotalScanned(result.data.totalScanned);
          setPage(pageNum);
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    },
    [userId]
  );

  useEffect(() => {
    if (userId > 0) fetchInputs(1, appliedSearch);
    return () => abortRef.current?.abort();
  }, [fetchInputs, userId, appliedSearch]);

  const handleApplySearch = () => setAppliedSearch(searchText);
  const handleReset = () => {
    setSearchText("");
    setAppliedSearch("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link href="/dashboard/audit">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("back")}
          </Button>
        </Link>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("search")}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleApplySearch()}
            className="pl-9"
          />
        </div>
        <Button onClick={handleApplySearch} size="sm">
          {t("apply")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleReset}>
          {t("reset")}
        </Button>
      </div>

      <div className="text-xs text-muted-foreground">{t("scanHint", { count: totalScanned })}</div>

      <div className="space-y-2">
        {!isLoading && items.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">{t("noData")}</div>
        )}
        {items.map((item) => (
          <Link
            key={`${item.sessionId}-${item.seq}-${item.idx}`}
            href={`/dashboard/audit/${item.sessionId}?at=${item.seq}:${item.idx}`}
            className="block"
          >
            <div className="group rounded-lg border bg-card p-3 transition hover:bg-muted/50">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <MessageSquare className="h-3 w-3" />
                <span className="font-mono">{item.sessionId.slice(0, 12)}…</span>
                <span>·</span>
                <span>{new Date(item.ts).toLocaleString()}</span>
                {item.model && (
                  <>
                    <span>·</span>
                    <span className="rounded bg-muted px-1.5 py-0.5">{item.model}</span>
                  </>
                )}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">
                {truncate(item.content, 500)}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-center gap-3 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchInputs(page - 1, appliedSearch)}
            disabled={page <= 1 || isLoading}
          >
            {t("prev")}
          </Button>
          <span className="text-xs text-muted-foreground">{page}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchInputs(page + 1, appliedSearch)}
            disabled={!hasMore || isLoading}
          >
            {t("next")}
          </Button>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
