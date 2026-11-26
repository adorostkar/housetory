import { Package, Search } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems } from "@/lib/queries";
import type { ItemListEntry } from "@/lib/types";
import { itemContainer, locationLabel } from "@/lib/utils";

/** Rows shown at once. The list does not scroll on its own; typing narrows it. */
const VISIBLE_ROWS = 5;

function placeLabel(item: ItemListEntry) {
  const container = itemContainer(item);
  const trail = item.location_path.map((entry) => locationLabel(entry));
  const parts = [
    item.property?.name,
    item.room?.name,
    ...(trail.length ? trail : container ? [locationLabel(container)] : []),
  ].filter(Boolean);
  return parts.filter(Boolean).join(" → ") || "No home location recorded";
}

function availableUnits(item: ItemListEntry) {
  return Math.max(0, item.quantity - (item.on_loan_quantity ?? 0));
}

/**
 * The item field of a new loan: a search with a few matches, or the chosen item.
 * Archived items and units already on loan are not available.
 */
export function LoanItemPicker({
  inputId,
  active,
  selected,
  onSelect,
  onClear,
}: {
  inputId: string;
  /** Load items only while the surface is open. */
  active: boolean;
  selected: ItemListEntry | null;
  onSelect: (item: ItemListEntry) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debounced.trim() || undefined, sort: "name_asc" },
    30,
    active && !selected,
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = itemsQuery.data?.pages[0]?.total ?? 0;
  const visible = items.slice(0, VISIBLE_ROWS);

  React.useEffect(() => {
    if (active) setSearch("");
  }, [active]);

  if (selected) {
    const available = availableUnits(selected);
    return (
      <div
        className="flex items-center gap-3 rounded-xl border border-border/70 bg-secondary/25 py-1.5 pl-3 pr-1.5"
        data-testid="loan-item-chosen"
      >
        <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{selected.name}</span>
          <span className="block truncate text-2xs text-muted-foreground">
            {placeLabel(selected)} · {available} available
          </span>
        </span>
        <Button
          id={inputId}
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={onClear}
          aria-label={`Change item, now ${selected.name}`}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your items"
          aria-label="Search inventory for a loan"
          autoComplete="off"
          className="pl-10"
        />
      </div>
      <div className="rounded-xl border border-border/70 bg-background/35 p-1">
        {itemsQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner /> Loading inventory…
          </div>
        ) : itemsQuery.isError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-5 text-center text-xs text-muted-foreground">
            <p>Inventory could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void itemsQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-5 text-center text-xs text-muted-foreground">
            {debounced.trim()
              ? "No active items match that search."
              : "No inventory items are available to lend."}
          </p>
        ) : (
          <ul>
            {visible.map((item) => {
              const available = availableUnits(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={available <= 0}
                    onClick={() => onSelect(item)}
                    aria-label={`Choose ${item.name} for a new loan`}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-secondary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{item.name}</span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {[item.brand, item.model].filter(Boolean).join(" · ")}
                        {item.brand || item.model ? " · " : ""}
                        {placeLabel(item)}
                      </span>
                    </span>
                    <Badge variant={available > 0 ? "sage" : "outline"} className="shrink-0">
                      {available > 0 ? `${available} available` : "None available"}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {total > visible.length && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Showing {visible.length} of {total} items. Type to find the rest.
        </p>
      )}
    </div>
  );
}
