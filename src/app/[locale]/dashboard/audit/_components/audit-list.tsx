"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import type { AuditSessionItem } from "@/actions/audit";
import { getAuditSessions } from "@/actions/audit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/routing";
import { AuditFilters, type AuditFilterValues } from "./audit-filters";

const PAGE_SIZE = 20;

export function AuditListClient() {
  const t = useTranslations("dashboard.audit");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AuditFilterValues>({
    search: "",
    model: "",
    startDate: "",
    endDate: "",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["audit-sessions", page, filters],
    queryFn: async () => {
      const result = await getAuditSessions({
        page,
        pageSize: PAGE_SIZE,
        search: filters.search || undefined,
        model: filters.model || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  const handleFilterChange = useCallback((newFilters: AuditFilterValues) => {
    setFilters(newFilters);
    setPage(1);
  }, []);

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const hasMore = data?.hasMore ?? false;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <AuditFilters onFilterChange={handleFilterChange} />

      {error ? (
        <div className="text-center text-destructive py-8">{error.message}</div>
      ) : isLoading ? (
        <LoadingSkeleton />
      ) : sessions.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">No audit data</div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.time")}</TableHead>
                  <TableHead>{t("columns.user")}</TableHead>
                  <TableHead>{t("columns.model")}</TableHead>
                  <TableHead className="text-right">{t("columns.requests")}</TableHead>
                  <TableHead className="text-right">{t("columns.tokens")}</TableHead>
                  <TableHead className="text-right">{t("columns.cost")}</TableHead>
                  <TableHead>{t("columns.summary")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <SessionRow key={session.sessionId ?? session.firstAt} session={session} />
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {total} sessions - page {page} / {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!hasMore}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SessionRow({ session }: { session: AuditSessionItem }) {
  const totalTokens = session.totalInputTokens + session.totalOutputTokens;
  const cost = Number.parseFloat(session.totalCost);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatTime(session.firstAt)}
      </TableCell>
      <TableCell>{session.userName ?? "-"}</TableCell>
      <TableCell>
        {session.model ? (
          <Badge variant="secondary" className="font-mono text-xs">
            {session.model}
          </Badge>
        ) : (
          "-"
        )}
      </TableCell>
      <TableCell className="text-right">{session.requestCount}</TableCell>
      <TableCell className="text-right font-mono text-xs">{totalTokens.toLocaleString()}</TableCell>
      <TableCell className="text-right font-mono text-xs">${cost.toFixed(4)}</TableCell>
      <TableCell className="max-w-xs truncate">
        {session.sessionId ? (
          <Link
            href={`/dashboard/audit/${session.sessionId}`}
            className="text-primary hover:underline"
          >
            {session.firstSummary || session.sessionId}
          </Link>
        ) : (
          (session.firstSummary ?? "-")
        )}
      </TableCell>
    </TableRow>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={`skeleton-${i}`} className="h-12 w-full" />
      ))}
    </div>
  );
}
