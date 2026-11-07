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
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
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
import type { ItemDetail, ItemDetailResponse } from "@/lib/types";
import { locationLabel, pluralize } from "@/lib/utils";

const SORTS = {
  name_asc: "Name A–Z",
  created_desc: "Newest first",
  updated_desc: "Recently updated",
} as const;

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
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
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
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
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
    return (
      <section className="surface p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-display text-[1.35rem] tracking-[-0.02em]">
              <PackageOpen className="size-4 text-brass" />
              Store items inside
            </h2>
            <p className="mt-2 max-w-2xl text-[0.8rem] leading-relaxed text-muted-foreground">
              Make this owned item act as a toolbox, box or piece of furniture that holds
              other inventory. Purchase, warranty, photos, documents, value and history stay
              on this item.
            </p>
            {item.quantity !== 1 ? (
              <p className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
                Quantity must be 1 before storage can be enabled. Represent separate physical
                boxes or furniture units as separate items; quantities are not split silently.
              </p>
            ) : !item.room ? (
              <p className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-[0.72rem] leading-relaxed text-muted-foreground">
                Assign this item to a room first so its storage place has a real location and
                QR identity.
              </p>
            ) : null}
          </div>
          {canWrite && (
            <Button
              type="button"
              variant="outline"
              disabled={item.quantity !== 1 || !item.room || item.is_archived}
              onClick={() => setDialogOpen(true)}
            >
              <PackageOpen />
              Store items inside
            </Button>
          )}
        </div>
        {canWrite && (
          <ItemStorageDialog
            item={item}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
          />
        )}
      </section>
    );
  }

  return (
    <section className="surface p-5 sm:p-6">
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
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.72rem] text-muted-foreground">
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
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-muted-foreground">
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
            <p className="mt-2 max-w-xl text-[0.74rem] leading-relaxed text-muted-foreground">
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

      {canWrite && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
            Removing storage never deletes this item or its ownership details. Move out every
            item, nested place and borrowed placement first; the server blocks an unsafe
            removal and nothing is deleted.
          </p>
        </div>
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
  const [sort, setSort] = React.useState<keyof typeof SORTS>("name_asc");
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
  });

  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <div className="surface mb-4 p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
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
                className={
                  scope === value
                    ? "rounded-full bg-primary px-3 py-1.5 text-[0.7rem] font-medium text-primary-foreground"
                    : "rounded-full px-3 py-1.5 text-[0.7rem] font-medium text-muted-foreground"
                }
              >
                {value === "nested" ? "Include nested" : "Direct only"}
              </button>
            ))}
          </div>
          <Select
            aria-label="Sort items inside this item"
            value={sort}
            onChange={(event) => {
              selection.clearSelection("Selection cleared because the sort changed.");
              setSort(event.target.value as keyof typeof SORTS);
            }}
            className="h-9 rounded-lg text-[0.8rem] lg:max-w-44"
          >
            {Object.entries(SORTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <BulkSelectionControls
            selection={selection}
            showing={items.length}
            total={total}
          />
          {addItemsContext && <AddItemsButton context={addItemsContext} variant="outline" size="sm" />}
        </div>
      </div>

      <BulkSelectionNotice selection={selection} />
      <BulkItemActionBar
        items={selection.selectedItems}
        onClear={() => selection.clearSelection()}
        onNotice={selection.showNotice}
      />

      {itemsQuery.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
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
          <div className="stagger grid gap-4 sm:grid-cols-2">
            {items.map((child) => (
              <div key={child.id} className="min-w-0">
                <ItemCard
                  item={child}
                  origin={origin}
                  selection={
                    canWrite
                      ? {
                          selected: selection.selected.has(child.id),
                          onToggle: () => selection.toggleItem(child.id),
                          disabled: child.is_archived,
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
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
