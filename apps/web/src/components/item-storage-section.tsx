import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  ChevronRight,
  MapPin,
  PackageOpen,
  Printer,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";

import {
  AddItemsButton,
  useAddItems,
  useRegisterAddItemsContext,
  type AddItemsContext,
} from "@/components/add-items";
import {
  BulkItemActionBar,
  BulkSelectButton,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemRow } from "@/components/item-card";
import { ItemStorageDialog } from "@/components/ownership-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCanWrite,
  useInvalidateInventory,
  useItems,
} from "@/lib/queries";
import { itemOrigin } from "@/lib/navigation";
import type { ItemDetail, ItemDetailResponse, ItemListEntry } from "@/lib/types";
import { cn, locationLabel, pluralize } from "@/lib/utils";

const SORTS = {
  location_asc: "By place",
  name_asc: "Name A–Z",
  created_desc: "Newest first",
  updated_desc: "Recently updated",
} as const;

interface PlaceGroup {
  key: string;
  label: string;
  items: ItemListEntry[];
}

/** Groups the items by the place they are in, named from the storage item downwards. */
function groupByPlace(items: ItemListEntry[], storageLocationId: string): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const item of items) {
    const path = item.location_path;
    const start = path.findIndex((entry) => entry.id === storageLocationId);
    const inside = start >= 0 ? path.slice(start + 1) : path;
    const key = item.location?.id ?? "";
    const label =
      key === storageLocationId || inside.length === 0
        ? "Directly inside"
        : inside.map((entry) => locationLabel(entry)).join(" / ");
    const group = groups.get(label) ?? { key: label, label, items: [] };
    group.items.push(item);
    groups.set(label, group);
  }
  const direct = groups.get("Directly inside");
  return [
    ...(direct ? [direct] : []),
    ...[...groups.values()].filter((group) => group !== direct),
  ];
}

export function ItemStorageSection({ item }: { item: ItemDetail }) {
  const canWrite = useCanWrite();
  const location = useLocation();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const storage = item.storage;
  const active = Boolean(storage?.active);
  const addItemsContext = React.useMemo<AddItemsContext | null>(
    () =>
      active && storage && item.room
        ? {
            propertyId: item.property?.id,
            roomId: item.room.id,
            locationId: storage.location_id,
            roomName: item.room.name,
            locationName: storage.identifier ?? storage.name,
          }
        : null,
    [active, item.property?.id, item.room, storage],
  );
  useRegisterAddItemsContext(addItemsContext);

  const restore = useMutation({
    mutationFn: () => api.post<ItemDetailResponse>(`/items/${item.id}/storage`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.item(item.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.locationsAll });
      invalidate();
      toast.success("Storage restored with its existing identifier and QR code");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<ItemDetailResponse>(`/items/${item.id}/storage`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.item(item.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.locationsAll });
      invalidate();
      setRemoveOpen(false);
      toast.success("Storage removed; its identifier and history remain recoverable");
    },
    onError: (error) => {
      setRemoveOpen(false);
      toast.error(getApiErrorMessage(error));
    },
  });

  if (!storage) {
    // An offer to writers only. Viewers have nothing to read here.
    if (!canWrite) return null;
    return (
      <section className="surface p-5">
        <h2 className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          <PackageOpen className="size-4" />
          Holds other items?
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Use this item as a toolbox, box or piece of furniture that holds other items.
        </p>
        {item.quantity !== 1 ? (
          <p className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            Quantity must be 1 before storage can be enabled. Represent separate physical
            boxes or furniture units as separate items; quantities are not split silently.
          </p>
        ) : !item.room ? (
          <p className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            Assign this item to a room first so its storage place has a real location and
            QR identity.
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          disabled={item.quantity !== 1 || !item.room || item.is_archived}
          onClick={() => setDialogOpen(true)}
        >
          <PackageOpen />
          Store items inside
        </Button>
        <ItemStorageDialog item={item} open={dialogOpen} onOpenChange={setDialogOpen} />
      </section>
    );
  }

  return (
    <section className="surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 font-display text-[1.35rem] tracking-[-0.02em]">
              <PackageOpen className="size-4 text-brass" />
              Contents
            </h2>
            {storage.active ? (
              <Badge variant="sage">Storage active</Badge>
            ) : (
              <Badge variant="outline">Storage removed</Badge>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <MapPin className="size-3" />
            {storage.active ? (
              <>
                {item.property && (
                  <span className="font-medium text-foreground/75">
                    {item.property.name}
                  </span>
                )}
                {item.room && (
                  <>
                    <ChevronRight className="size-3" />
                    <Link
                      to={`/rooms/${item.room.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {item.room.name}
                    </Link>
                  </>
                )}
                {storage.path.map((entry) => (
                  <span key={entry.id} className="inline-flex items-center gap-1.5">
                    <ChevronRight className="size-3" />
                    <Link
                      to={
                        entry.is_container
                          ? `/containers/${entry.id}`
                          : `/rooms/${item.room?.id}?location_id=${entry.id}`
                      }
                      className="underline-offset-4 hover:underline"
                    >
                      {locationLabel(entry)}
                    </Link>
                  </span>
                ))}
              </>
            ) : (
              <span>
                {storage.identifier ?? storage.name} · recoverable
              </span>
            )}
          </p>
          {storage.active && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
              <span>
                {pluralize(storage.item_count, "item")} ·{" "}
                {pluralize(storage.total_quantity, "nested unit")}
              </span>
              <span>·</span>
              <span>
                {pluralize(storage.direct_item_count, "item")} ·{" "}
                {storage.direct_total_quantity} directly here
              </span>
              {storage.categories.slice(0, 6).map((category) => (
                <Badge key={category.name} variant="outline">
                  {category.name} · {category.item_count}
                </Badge>
              ))}
            </div>
          )}
          {!storage.active && (
            <p className="mt-2 max-w-xl text-2xs leading-relaxed text-muted-foreground">
              The storage capability was removed only when it was empty. Restoring it reuses
              the same container identity and QR code.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {storage.active && (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/containers/${storage.location_id}`}>
                  <Boxes />
                  Storage page
                </Link>
              </Button>
              {storage.identifier && (
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/labels?ids=${storage.location_id}`}>
                    <Printer />
                    Print label
                  </Link>
                </Button>
              )}
              {canWrite && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoveOpen(true)}
                >
                  <Trash2 />
                  Remove storage
                </Button>
              )}
            </>
          )}
          {!storage.active && canWrite && (
            <Button
              variant="outline"
              size="sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate()}
            >
              <Undo2 />
              Restore storage
            </Button>
          )}
        </div>
      </div>

      {storage.active && (
        <ContentsBody
          storageLocationId={storage.location_id}
          addItemsContext={addItemsContext}
          origin={itemOrigin(`${location.pathname}${location.search}`, item.name)}
        />
      )}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove storage from ${item.name}?`}
        description="The item keeps its purchase, warranty, photos, documents, value and history. The empty storage place is recoverably deleted and can be restored with the same identifier. If anything remains inside, the server blocks this and nothing changes."
        confirmLabel="Remove storage"
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </section>
  );
}

function ContentsBody({
  storageLocationId,
  addItemsContext,
  origin,
}: {
  storageLocationId: string;
  addItemsContext: AddItemsContext | null;
  origin: ReturnType<typeof itemOrigin>;
}) {
  const canWrite = useCanWrite();
  const { openAddItems } = useAddItems();
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 300);
  const [scope, setScope] = React.useState<"nested" | "direct">("nested");
  const [sort, setSort] = React.useState<keyof typeof SORTS>("location_asc");
  const itemsQuery = useItems(
    {
      q: debounced.trim() || undefined,
      location_id: storageLocationId,
      include_descendants: scope === "nested",
      sort,
    },
    24,
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = itemsQuery.data?.pages[0]?.total ?? 0;
  const filterSignature = JSON.stringify([storageLocationId, scope, debounced, sort]);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
    onRequest: true,
  });

  // By place, the server returns the items place by place, so headings can sit between them.
  const groups = sort === "location_asc" ? groupByPlace(items, storageLocationId) : null;
  const renderRow = (child: ItemListEntry) => (
    <ItemRow
      key={child.id}
      item={child}
      origin={origin}
      selection={selection.itemSelection(child)}
    />
  );

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-3 space-y-2">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              selection.clearSelection("Selection cleared because the search changed.");
            }}
            placeholder="Search inside this item"
            aria-label="Search inside this item"
            className="pl-10"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-full border border-border/70 bg-background/50 p-1"
            role="group"
            aria-label="Contents scope"
          >
            {(["nested", "direct"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => {
                  selection.clearSelection("Selection cleared because the scope changed.");
                  setScope(value);
                }}
                className={cn(
                  "min-h-9 rounded-full px-3 text-2xs font-medium",
                  scope === value ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {value === "nested" ? "Include nested" : "Direct only"}
              </button>
            ))}
          </div>
          <div className="w-40">
            <Select
              aria-label="Sort items inside this item"
              value={sort}
              onChange={(event) => {
                selection.clearSelection("Selection cleared because the sort changed.");
                setSort(event.target.value as keyof typeof SORTS);
              }}
              className="rounded-lg text-sm"
            >
              {Object.entries(SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BulkSelectionControls
            selection={selection}
            showing={items.length}
            total={total}
          />
          <div className="ml-auto flex items-center gap-2">
            {canWrite && items.length > 0 && <BulkSelectButton selection={selection} />}
            {addItemsContext && (
              <AddItemsButton context={addItemsContext} variant="outline" size="sm" />
            )}
          </div>
        </div>
      </div>

      <BulkSelectionNotice selection={selection} />
      <BulkItemActionBar
        items={selection.selectedItems}
        onClear={selection.stopSelecting}
        onNotice={selection.showNotice}
      />

      {itemsQuery.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : itemsQuery.isError ? (
        <ErrorState
          message="We couldn't load the items inside this storage."
          onRetry={() => void itemsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={scope === "direct" ? "No direct items here." : "This storage is empty."}
          description={
            scope === "direct"
              ? "Nested places may still contain items. Switch to Include nested to see them."
              : "Add an item and assign it here, or move an existing item into this place."
          }
          actionLabel="Add items"
          onAction={() => openAddItems(addItemsContext ?? undefined)}
        />
      ) : (
        <>
          {groups ? (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h3 className="mb-1 flex items-baseline justify-between gap-2 px-1 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="shrink-0 font-normal normal-case tracking-normal">
                      {group.items.length}
                    </span>
                  </h3>
                  <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 p-1">
                    {group.items.map(renderRow)}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 p-1">
              {items.map(renderRow)}
            </div>
          )}
          {selection.selectedItems.length > 0 && <div aria-hidden="true" className="h-24" />}
          {itemsQuery.hasNextPage && (
            <div className="mt-5 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void itemsQuery.fetchNextPage()}
                disabled={itemsQuery.isFetchingNextPage}
              >
                {itemsQuery.isFetchingNextPage ? "Loading…" : "Load more items"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
