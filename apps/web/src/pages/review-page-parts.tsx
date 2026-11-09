import { useQuery } from "@tanstack/react-query";
import { Search, Sparkles } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import { appendOrigin, itemOrigin, rememberListScroll } from "@/lib/navigation";
import type { ItemList, ItemSummary, ReviewSuggestion } from "@/lib/types";
import { pluralize } from "@/lib/utils";
import { STATUS_VARIANTS, TYPE_LABELS } from "@/pages/review-page-helpers";

export function SuggestionStatusBadge({ suggestion }: { suggestion: ReviewSuggestion }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="outline">{TYPE_LABELS[suggestion.type]}</Badge>
      {suggestion.source === "ai" && (
        <Badge variant="brass">
          <Sparkles className="size-3" /> AI-assisted
        </Badge>
      )}
      <Badge variant={STATUS_VARIANTS[suggestion.status]}>
        {suggestion.status}
      </Badge>
    </div>
  );
}

export function ItemReference({
  item,
  origin,
  label,
}: {
  item: ItemSummary;
  origin: ReturnType<typeof itemOrigin>;
  label?: string;
}) {
  return (
    <Link
      to={appendOrigin(`/items/${item.id}`, origin)}
      onClick={() => rememberListScroll(origin ?? null)}
      className="min-w-0 break-words font-medium underline-offset-4 hover:underline"
    >
      {label ?? item.name}
      {item.quantity > 1 ? ` ×${item.quantity}` : ""}
    </Link>
  );
}

export function ItemPickerDialog({
  open,
  onOpenChange,
  selectedIds,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onConfirm: (ids: string[]) => void;
}) {
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 250);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: ["inventory-review", "picker", debounced],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100", sort: "name_asc" });
      if (debounced.trim()) params.set("q", debounced.trim());
      return api.get<ItemList>(`/items?${params.toString()}`);
    },
    enabled: open,
    staleTime: 10_000,
  });

  React.useEffect(() => {
    if (!open) return;
    setSelected(new Set(selectedIds));
    setSearch("");
  }, [open, selectedIds]);

  const items = query.data?.items ?? [];
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Select items to review</DialogTitle>
          <DialogDescription>
            Choose up to 100 items. Reviewing selected items never changes them.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items"
            aria-label="Search items to review"
            className="pl-10"
          />
        </div>
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        ) : query.isError ? (
          <FormError message={getApiErrorMessage(query.error)} />
        ) : items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-4 text-2xs text-muted-foreground">
            No items match that search.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {items.map((item) => (
              <li key={item.id}>
                <label className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 text-xs hover:bg-secondary/30">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                      {[item.room?.name, item.location?.name, item.brand, item.model]
                        .filter(Boolean)
                        .join(" · ") || "No placement or detail"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onConfirm([...selected]);
              onOpenChange(false);
            }}
          >
            Use {pluralize(selected.size, "item")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
