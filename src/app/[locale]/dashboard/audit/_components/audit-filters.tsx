"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { getAuditModels, getAuditUsers } from "@/actions/audit";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface AuditFilterValues {
  search: string;
  userId: string;
  model: string;
  startDate: string;
  endDate: string;
}

function getDefaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function getDefaultEndDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_FILTERS: AuditFilterValues = {
  search: "",
  userId: "",
  model: "",
  startDate: getDefaultStartDate(),
  endDate: getDefaultEndDate(),
};

interface AuditFiltersProps {
  onFilterChange: (filters: AuditFilterValues) => void;
}

export function AuditFilters({ onFilterChange }: AuditFiltersProps) {
  const t = useTranslations("dashboard.audit.filters");
  const [filters, setFilters] = useState<AuditFilterValues>(DEFAULT_FILTERS);
  const [userOpen, setUserOpen] = useState(false);

  const { data: models } = useQuery({
    queryKey: ["audit-models"],
    queryFn: async () => {
      const result = await getAuditModels();
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  const { data: users } = useQuery({
    queryKey: ["audit-users"],
    queryFn: async () => {
      const result = await getAuditUsers();
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  });

  const selectedUserName = users?.find((u) => String(u.userId) === filters.userId)?.userName;

  const handleApply = useCallback(() => {
    onFilterChange(filters);
  }, [filters, onFilterChange]);

  const handleReset = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    onFilterChange(DEFAULT_FILTERS);
  }, [onFilterChange]);

  return (
    <div className="flex flex-wrap items-end gap-2">
      {/* Search */}
      <div className="relative w-52">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("search")}
          value={filters.search}
          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          className="pl-9"
          onKeyDown={(e) => e.key === "Enter" && handleApply()}
        />
      </div>

      {/* User combobox (searchable) */}
      <Popover open={userOpen} onOpenChange={setUserOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={userOpen}
            className="w-40 justify-between font-normal"
          >
            <span className="truncate">
              {selectedUserName || t("user")}
            </span>
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("user")} />
            <CommandList className="max-h-48 overflow-y-auto">
              <CommandEmpty>No users found</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value=""
                  onSelect={() => {
                    setFilters((prev) => ({ ...prev, userId: "" }));
                    setUserOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-3.5 w-3.5", !filters.userId ? "opacity-100" : "opacity-0")} />
                  {t("user")}
                </CommandItem>
                {users?.map((u) => (
                  <CommandItem
                    key={u.userId}
                    value={u.userName}
                    onSelect={() => {
                      setFilters((prev) => ({
                        ...prev,
                        userId: String(u.userId),
                      }));
                      setUserOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3.5 w-3.5",
                        filters.userId === String(u.userId) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {u.userName}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Model select */}
      <Select
        value={filters.model}
        onValueChange={(value) =>
          setFilters((prev) => ({ ...prev, model: value === "all" ? "" : value }))
        }
      >
        <SelectTrigger className="w-40">
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

      {/* Quick date presets */}
      <div className="flex items-center gap-1">
        {[
          { label: t("today"), days: 0 },
          { label: t("last7days"), days: 7 },
          { label: t("last30days"), days: 30 },
        ].map(({ label, days }) => {
          const start = new Date();
          start.setDate(start.getDate() - days);
          const startStr = start.toISOString().slice(0, 10);
          const endStr = new Date().toISOString().slice(0, 10);
          const isActive = filters.startDate === startStr && filters.endDate === endStr;
          return (
            <Button
              key={days}
              variant={isActive ? "default" : "outline"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => setFilters((prev) => ({ ...prev, startDate: startStr, endDate: endStr }))}
            >
              {label}
            </Button>
          );
        })}
      </div>

      {/* Custom date range */}
      <Input
        type="date"
        value={filters.startDate}
        onChange={(e) => setFilters((prev) => ({ ...prev, startDate: e.target.value }))}
        className="w-32 text-xs"
      />
      <span className="text-muted-foreground">-</span>
      <Input
        type="date"
        value={filters.endDate}
        onChange={(e) => setFilters((prev) => ({ ...prev, endDate: e.target.value }))}
        className="w-32 text-xs"
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
