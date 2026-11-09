import { Search } from "lucide-react";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems } from "@/lib/queries";
import type { ItemSummary } from "@/lib/types";
import { formatDate } from "@/lib/utils";

export function ItemSearchPicker({
  onSelect,
  disabled,
}: {
  onSelect: (item: ItemSummary) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debounced.trim() || undefined, sort: "name_asc", include_archived: false },
    20,
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-background/60 p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the household inventory"
          aria-label="Search inventory for this line"
          className="h-9 pl-8 text-xs"
          disabled={disabled}
        />
      </div>
      <div className="mt-1 max-h-52 overflow-y-auto">
        {itemsQuery.isPending ? (
          <p className="flex items-center justify-center gap-2 py-4 text-2xs text-muted-foreground">
            <Spinner className="size-3.5" /> Searching…
          </p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-2xs text-muted-foreground">
            No item matches that search.
          </p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(item)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary/70"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{item.name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {[item.room?.name, item.location?.name].filter(Boolean).join(" / ") ||
                    "No place"}
                  {item.purchase?.purchase_date ? ` · ${formatDate(item.purchase.purchase_date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">×{item.quantity}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
