import { HandCoins, Package, Search } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems } from "@/lib/queries";
import type { ItemSummary } from "@/lib/types";
import { itemContainer, locationLabel } from "@/lib/utils";

function placeLabel(item: ItemSummary) {
  const container = itemContainer(item);
  const trail = item.location_path.map((entry) => locationLabel(entry));
  const parts = [
    item.property?.name,
    item.room?.name,
    ...(trail.length ? trail : container ? [locationLabel(container)] : []),
  ].filter(Boolean);
  return parts.filter(Boolean).join(" → ") || "No home location recorded";
}

export function LoanItemPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: ItemSummary) => void;
}) {
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debounced.trim() || undefined, sort: "name_asc" },
    30,
    open,
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = itemsQuery.data?.pages[0]?.total ?? 0;

  React.useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="size-4 text-brass" />
            New loan
          </DialogTitle>
          <DialogDescription>
            Choose an item from this household, then enter the borrower, quantity and
            dates. Archived items and units already on loan are not available.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search inventory"
            aria-label="Search inventory for a loan"
            className="pl-10"
          />
        </div>

        <div className="max-h-[min(55vh,420px)] overflow-y-auto rounded-xl border border-border/70 bg-background/35 p-1.5">
          {itemsQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <Spinner /> Loading inventory…
            </div>
          ) : itemsQuery.isError ? (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-xs text-muted-foreground">
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
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              {debounced.trim()
                ? "No active items match that search."
                : "No inventory items are available to lend."}
            </p>
          ) : (
            items.map((item) => {
              const available = Math.max(
                0,
                item.quantity - (item.on_loan_quantity ?? 0),
              );
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-secondary/50"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                    <Package className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {item.name}
                    </span>
                    {(item.brand || item.model) && (
                      <span className="block truncate text-2xs text-muted-foreground">
                        {[item.brand, item.model].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    <span className="block truncate text-2xs text-muted-foreground">
                      {placeLabel(item)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant={available > 0 ? "sage" : "outline"}>
                      {available > 0
                        ? `${available} available`
                        : "None available"}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-2xs"
                      disabled={available <= 0}
                      onClick={() => onSelect(item)}
                      aria-label={`Choose ${item.name} for a new loan`}
                    >
                      Choose
                    </Button>
                  </span>
                </div>
              );
            })
          )}
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {total > items.length
            ? `Showing ${items.length} of ${total} matching items. Refine the search to find the rest.`
            : "Available quantities are current household records. The server rechecks stock when the loan is saved."}
        </p>
      </DialogContent>
    </Dialog>
  );
}
