"use client";

import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { getAuditModels } from "@/actions/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface AuditFilterValues {
  search: string;
  model: string;
  startDate: string;
  endDate: string;
}

const EMPTY_FILTERS: AuditFilterValues = {
  search: "",
  model: "",
  startDate: "",
  endDate: "",
};

interface AuditFiltersProps {
  onFilterChange: (filters: AuditFilterValues) => void;
}

export function AuditFilters({ onFilterChange }: AuditFiltersProps) {
  const t = useTranslations("dashboard.audit.filters");
  const [filters, setFilters] = useState<AuditFilterValues>(EMPTY_FILTERS);

  const { data: models } = useQuery({
    queryKey: ["audit-models"],
    queryFn: async () => {
      const result = await getAuditModels();
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  const handleApply = useCallback(() => {
    onFilterChange(filters);
  }, [filters, onFilterChange]);

  const handleReset = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    onFilterChange(EMPTY_FILTERS);
  }, [onFilterChange]);

  return (
    <div className="flex flex-wrap items-end gap-3">
      {/* Search */}
      <div className="relative w-64">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("search")}
          value={filters.search}
          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          className="pl-9"
        />
      </div>

      {/* Model select */}
      <Select
        value={filters.model}
        onValueChange={(value) =>
          setFilters((prev) => ({ ...prev, model: value === "all" ? "" : value }))
        }
      >
        <SelectTrigger className="w-48">
          <SelectValue placeholder={t("model")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("model")}</SelectItem>
          {models?.map((model) => (
            <SelectItem key={model} value={model}>
              {model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Start date */}
      <Input
        type="date"
        value={filters.startDate}
        onChange={(e) => setFilters((prev) => ({ ...prev, startDate: e.target.value }))}
        className="w-40"
        placeholder={t("startDate")}
      />

      {/* End date */}
      <Input
        type="date"
        value={filters.endDate}
        onChange={(e) => setFilters((prev) => ({ ...prev, endDate: e.target.value }))}
        className="w-40"
        placeholder={t("endDate")}
      />

      {/* Actions */}
      <Button onClick={handleApply} size="sm">
        {t("apply")}
      </Button>
      <Button onClick={handleReset} variant="outline" size="sm">
        {t("reset")}
      </Button>
    </div>
  );
}
