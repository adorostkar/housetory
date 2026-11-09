import { Check, Package, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems } from "@/lib/queries";
import type { ItemSummary } from "@/lib/types";
import { cn, pluralize } from "@/lib/utils";

export function ItemMultiSelect({
  selected,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debouncedSearch.trim() || undefined, sort: "name_asc", include_archived: true },
    100,
  );
  const items = useMemo(
    () => itemsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [itemsQuery.data],
  );
  const selectedSet = new Set(selected);

  const toggle = (item: ItemSummary) => {
    if (selectedSet.has(item.id)) {
      onChange(selected.filter((id) => id !== item.id));
    } else {
      onChange([...selected, item.id]);
    }
  };

  return (
    <div>
      {label && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-medium">{label}</span>
          <span className="text-2xs text-muted-foreground">
            {pluralize(selected.length, "item")} selected
          </span>
        </div>
      )}
      {hint && <p className="mb-2 text-2xs text-muted-foreground">{hint}</p>}
      <div className="rounded-xl border border-border bg-background/50">
        <div className="relative border-b border-border/70">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find an item…"
            aria-label="Find items"
            className="h-10 w-full rounded-t-xl bg-transparent pl-9 pr-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:opacity-50"
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1.5">
          {itemsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 py-8 text-2xs text-muted-foreground">
              <Spinner /> Loading items…
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-2xs text-muted-foreground">
              {search.trim() ? "No items match that search." : "No items yet."}
            </p>
          ) : (
            items.map((item) => {
              const active = selectedSet.has(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(item)}
                  aria-pressed={active}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    active ? "bg-secondary" : "hover:bg-secondary/60",
                    disabled && "opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card",
                    )}
                  >
                    {active && <Check className="size-3" />}
                  </span>
                  {item.primary_photo ? (
                    <img
                      src={item.primary_photo.thumbnail_url}
                      alt=""
                      loading="lazy"
                      className="size-8 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                      <Package className="size-3.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {item.name}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {[item.room?.name, item.category?.name].filter(Boolean).join(" · ") ||
                        "No place yet"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
