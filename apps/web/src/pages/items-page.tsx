import {
  FolderTree,
  LayoutGrid,
  List,
  MoveRight,
  Search,
  SlidersHorizontal,
  Tags,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useDebouncedValue } from "@/hooks/use-debounced-value";

import { AddItemsButton, useAddItems } from "@/components/add-items";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import {
  BulkCategoryDialog,
  BulkMoveDialog,
  BulkTagDialog,
} from "@/components/bulk-organise-dialogs";
import { ItemCard, ItemRow } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCanWrite,
  useCategories,
  useItems,
  useLocations,
  useRooms,
  useTags,
} from "@/lib/queries";
import {
  cn,
  flattenLocations,
  flattenRoomTree,
  locationLabel,
  locationPath,
  pluralize,
  roomPath,
} from "@/lib/utils";

const SORTS = {
  created_desc: "Newest first",
  name_asc: "Name A–Z",
  name_desc: "Name Z–A",
  updated_desc: "Recently updated",
} as const;

type SortKey = keyof typeof SORTS;

function isSortKey(value: string | null): value is SortKey {
  return value !== null && value in SORTS;
}

export function ItemsPage() {
  const { openAddItems } = useAddItems();
  const canWrite = useCanWrite();
  const [searchParams, setSearchParams] = useSearchParams();
  const qParam = searchParams.get("q") ?? "";
  const roomFilter = searchParams.get("room_id") ?? "";
  const locationFilter = searchParams.get("location_id") ?? "";
  const categoryFilter = searchParams.get("category_id") ?? "";
  const tagFilter = searchParams.get("tag_id") ?? "";
  const purchaseInfo = searchParams.get("purchase_info") ?? "";
  const archived = searchParams.get("archived") === "1";
  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "created_desc";

  const [search, setSearch] = useState(qParam);
  const debouncedSearch = useDebouncedValue(search, 300);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("housetory.items.view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [bulkDialog, setBulkDialog] = useState<"move" | "tags" | "category" | null>(
    null,
  );
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const roomsQuery = useRooms();
  const locationsQuery = useLocations(roomFilter || undefined);
  const categoriesQuery = useCategories();
  const tagsQuery = useTags();

  useEffect(() => {
    try {
      localStorage.setItem("housetory.items.view", view);
    } catch {
      // Browsing-private storage failures should not break the list.
    }
  }, [view]);

  useEffect(() => {
    const trimmed = debouncedSearch.trim();
    if (trimmed === qParam) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, qParam, setSearchParams]);

  const filters = {
    q: qParam || undefined,
    room_id: roomFilter || undefined,
    location_id: locationFilter || undefined,
    category_id: categoryFilter || undefined,
    tag_id: tagFilter || undefined,
    purchase_info: purchaseInfo || undefined,
    include_archived: archived,
    include_descendants: true,
    sort,
  };
  const itemsQuery = useItems(filters, 24);
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = itemsQuery.data?.pages[0]?.total ?? 0;
  const filterSignature = JSON.stringify([
    qParam,
    roomFilter,
    locationFilter,
    categoryFilter,
    tagFilter,
    purchaseInfo,
    archived,
    sort,
  ]);
  const previousFilterSignature = useRef(filterSignature);
  const loadedIdsKey = items.map((item) => item.id).join("|");
  const selectableItems = items.filter((item) => !item.is_archived);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allLoadedSelected =
    selectableItems.length > 0 && selectableItems.every((item) => selected.has(item.id));
  const someLoadedSelected = selectableItems.some((item) => selected.has(item.id));
  const selectedUnits = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
  const selectedOnLoan = selectedItems.reduce(
    (sum, item) => sum + (item.on_loan_quantity ?? 0),
    0,
  );
  const hasArchivedSelection = selectedItems.some((item) => item.is_archived);
  const hasFilters = Boolean(
    qParam ||
      roomFilter ||
      locationFilter ||
      categoryFilter ||
      tagFilter ||
      purchaseInfo ||
      archived,
  );

  useEffect(() => {
    if (previousFilterSignature.current === filterSignature) return;
    previousFilterSignature.current = filterSignature;
    setSelected(new Set());
    if (selectedRef.current.size > 0) {
      setSelectionNotice("Selection cleared because the view changed.");
    }
  }, [filterSignature]);

  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const loaded = new Set(loadedIdsKey.split("|").filter(Boolean));
      const next = new Set([...current].filter((id) => loaded.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [loadedIdsKey]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someLoadedSelected && !allLoadedSelected;
    }
  }, [someLoadedSelected, allLoadedSelected]);

  const clearSelection = (message?: string) => {
    setSelected(new Set());
    if (message && selectedRef.current.size > 0) setSelectionNotice(message);
  };

  const toggleItem = (itemId: string) => {
    if (!canWrite) return;
    setSelectionNotice(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleAllLoaded = () => {
    if (!canWrite) return;
    setSelectionNotice(null);
    setSelected((current) => {
      if (selectableItems.every((item) => current.has(item.id))) {
        return new Set();
      }
      return new Set(selectableItems.map((item) => item.id));
    });
  };
  const roomOptions = flattenRoomTree(roomsQuery.data?.items ?? []);
  const locationOptions = flattenLocations(locationsQuery.data?.items ?? []);
  const categoryOptions = (categoriesQuery.data?.items ?? []).filter(
    (category) => category.item_count > 0 || category.id === categoryFilter,
  );
  const tagOptions = (tagsQuery.data?.items ?? []).filter(
    (tag) => tag.item_count > 0 || tag.id === tagFilter,
  );
  const purchaseInfoLabels: Record<string, string> = {
    missing: "Missing or unknown",
    unknown: "Purchase info unknown",
    not_applicable: "Not applicable",
    recorded: "Recorded",
    missing_date: "Missing purchase date",
    missing_price: "Missing purchase price",
  };
  const activeFilterChips = [
    qParam
      ? {
          key: "q",
          label: `Search: ${qParam}`,
          remove: () => {
            setSearch("");
            updateParam("q", "");
          },
        }
      : null,
    roomFilter
      ? {
          key: "room",
          label: `Room: ${roomPath(roomsQuery.data?.items ?? [], roomFilter)
            .map((entry) => entry.name)
            .join(" / ")}`,
          remove: () => updateRoomFilter(""),
        }
      : null,
    locationFilter
      ? {
          key: "location",
          label: `Place: ${locationPath(
            locationsQuery.data?.items ?? [],
            locationFilter,
          )
            .map((entry) => locationLabel(entry))
            .join(" / ")}`,
          remove: () => updateParam("location_id", ""),
        }
      : null,
    categoryFilter
      ? {
          key: "category",
          label: `Category: ${
            categoriesQuery.data?.items.find((entry) => entry.id === categoryFilter)
              ?.name ?? "Selected"
          }`,
          remove: () => updateParam("category_id", ""),
        }
      : null,
    tagFilter
      ? {
          key: "tag",
          label: `Tag: ${
            tagsQuery.data?.items.find((entry) => entry.id === tagFilter)?.name ??
            "Selected"
          }`,
          remove: () => updateParam("tag_id", ""),
        }
      : null,
    purchaseInfo
      ? {
          key: "purchase",
          label: `Purchase: ${purchaseInfoLabels[purchaseInfo] ?? purchaseInfo}`,
          remove: () => updateParam("purchase_info", ""),
        }
      : null,
    archived
      ? {
          key: "archived",
          label: "Includes archived",
          remove: () => updateParam("archived", ""),
        }
      : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);

  useEffect(() => {
    if (!locationFilter) return;
    const invalid =
      !roomFilter ||
      (locationsQuery.isSuccess &&
        !locationsQuery.data.items.some((location) => location.id === locationFilter));
    if (invalid) {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete("location_id");
          return next;
        },
        { replace: true },
      );
    }
  }, [locationFilter, roomFilter, locationsQuery.isSuccess, locationsQuery.data, setSearchParams]);

  const updateParam = (key: string, value: string) => {
    clearSelection("Selection cleared because the view changed.");
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const updateRoomFilter = (roomId: string) => {
    clearSelection("Selection cleared because the view changed.");
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (roomId) next.set("room_id", roomId);
      else next.delete("room_id");
      next.delete("location_id");
      return next;
    });
  };

  const clearFilters = () => {
    setSearch("");
    clearSelection("Selection cleared because the view changed.");
    setSearchParams({}, { replace: true });
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Collection"
        title="Items"
        description={
          itemsQuery.data
            ? `${pluralize(total, "item")} recorded${hasFilters ? " matching your filters" : " across your home"}.`
            : "Everything in your home, in one considered place."
        }
        actions={<AddItemsButton />}
      />

      <div className="surface mb-8 p-3.5 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                clearSelection("Selection cleared because the search changed.");
              }}
              placeholder="Search items"
              aria-label="Search items"
              className="pl-10"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="hidden items-center gap-2 text-[0.75rem] text-muted-foreground sm:flex">
            <SlidersHorizontal className="size-3.5" />
            <span>Filters</span>
          </div>
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar sm:grid sm:grid-cols-3 sm:overflow-visible sm:pb-0 lg:grid-cols-6">
          <div className="min-w-[145px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by room"
              value={roomFilter}
              onChange={(event) => updateRoomFilter(event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              <option value="">All rooms</option>
              {roomOptions.map(({ room }) => (
                <option key={room.id} value={room.id}>
                  {roomPath(roomsQuery.data?.items ?? [], room.id)
                    .map((entry) => entry.name)
                    .join(" / ")}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-[160px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by storage location"
              value={locationFilter}
              disabled={!roomFilter}
              onChange={(event) => updateParam("location_id", event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              <option value="">{roomFilter ? "All places" : "Choose a room"}</option>
              {locationOptions.map(({ location }) => (
                <option key={location.id} value={location.id}>
                  {locationPath(locationsQuery.data?.items ?? [], location.id)
                    .map((entry) => locationLabel(entry))
                    .join(" / ")}
                </option>
              ))}
            </Select>
          </div>

          {categoryOptions.length > 0 ? (
            <div className="min-w-[145px] shrink-0 sm:min-w-0">
              <Select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(event) => updateParam("category_id", event.target.value)}
                className="h-9 rounded-lg text-[0.8rem]"
              >
                <option value="">All categories</option>
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="flex min-w-[145px] shrink-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-[0.72rem] text-muted-foreground sm:min-w-0">
              No categories yet
            </div>
          )}

          {tagOptions.length > 0 ? (
            <div className="min-w-[145px] shrink-0 sm:min-w-0">
              <Select
                aria-label="Filter by tag"
                value={tagFilter}
                onChange={(event) => updateParam("tag_id", event.target.value)}
                className="h-9 rounded-lg text-[0.8rem]"
              >
                <option value="">All tags</option>
                {tagOptions.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="flex min-w-[145px] shrink-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-[0.72rem] text-muted-foreground sm:min-w-0">
              No tags yet
            </div>
          )}

          <div className="min-w-[165px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by purchase information"
              value={purchaseInfo}
              onChange={(event) => updateParam("purchase_info", event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              <option value="">Any purchase info</option>
              <option value="missing">Missing or unknown</option>
              <option value="recorded">Recorded</option>
              <option value="unknown">Unknown</option>
              <option value="not_applicable">Not applicable</option>
              <option value="missing_date">Missing purchase date</option>
              <option value="missing_price">Missing purchase price</option>
            </Select>
          </div>

          <div className="min-w-[145px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Sort items"
              value={sort}
              onChange={(event) => updateParam("sort", event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              {Object.entries(SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <label className="flex h-9 min-w-[120px] shrink-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-[0.78rem] text-muted-foreground sm:min-w-0">
            <Switch
              checked={archived}
              onCheckedChange={(checked) => updateParam("archived", checked ? "1" : "")}
              aria-label="Show archived items"
              className="h-5 w-9 [&>span]:size-4 data-[state=checked]:[&>span]:translate-x-4"
            />
            Archived
          </label>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="shrink-0 justify-start text-muted-foreground"
            >
              <X />
              Clear all
            </Button>
          )}
        </div>

        {activeFilterChips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
            {activeFilterChips.map((chip) => (
              <Badge
                key={chip.key}
                variant="secondary"
                className="gap-1 py-1 pl-2.5 pr-1.5 text-[0.68rem]"
              >
                <span className="max-w-64 truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={chip.remove}
                  className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background/70 hover:text-foreground"
                  aria-label={`Remove ${chip.label}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 text-[0.68rem] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Reset all filters
            </button>
          </div>
        )}
      </div>

      {selectionNotice && (
        <div
          className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-secondary/25 px-3.5 py-2.5 text-[0.74rem] leading-relaxed text-muted-foreground"
          role="status"
        >
          <span>{selectionNotice}</span>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 hover:bg-secondary hover:text-foreground"
            onClick={() => setSelectionNotice(null)}
            aria-label="Dismiss selection notice"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.74rem] text-muted-foreground">
            {canWrite && (
              <label className="flex min-w-0 items-center gap-2">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={allLoadedSelected}
                  disabled={selectableItems.length === 0}
                  onChange={toggleAllLoaded}
                  aria-label="Select all loaded items"
                />
                <span>
                  Select all loaded ({selectableItems.length})
                </span>
              </label>
            )}
            <span aria-hidden>·</span>
            <span>
              Showing {items.length} of {total}
              {items.length < total
                ? "; only loaded items can be selected"
                : ""}
            </span>
          </div>
          <div
            className="flex items-center gap-1 rounded-lg border border-border/70 bg-card/55 p-1"
            role="group"
            aria-label="Item view"
          >
            <button
              type="button"
              className={cn(
                "flex size-7 items-center justify-center rounded-md transition-colors",
                view === "grid"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Card view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <LayoutGrid className="size-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                "flex size-7 items-center justify-center rounded-md transition-colors",
                view === "list"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Compact list view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {canWrite && selectedItems.length > 0 && (
        <div className="surface mb-4 flex flex-col gap-3 border-brass/25 bg-brass-soft/25 p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[0.78rem]">
            <p className="font-medium">
              {pluralize(selectedItems.length, "item")} selected ·{" "}
              {pluralize(selectedUnits, "unit")}
            </p>
            <p className="mt-0.5 text-[0.68rem] text-muted-foreground">
              {selectedOnLoan > 0
                ? `${selectedOnLoan} unit(s) on loan; their home place can move without changing loans.`
                : "Bulk actions apply to the selected loaded records only."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={hasArchivedSelection}
              onClick={() => setBulkDialog("move")}
            >
              <MoveRight />
              Move
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={hasArchivedSelection}
              onClick={() => setBulkDialog("tags")}
            >
              <Tags />
              Tags
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={hasArchivedSelection}
              onClick={() => setBulkDialog("category")}
            >
              <FolderTree />
              Category
            </Button>
            <Button size="sm" variant="ghost" onClick={() => clearSelection()}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {itemsQuery.isPending ? (
        <ItemGridSkeleton />
      ) : itemsQuery.isError ? (
        <ErrorState
          title="The collection is out of reach"
          message="We couldn't load your items just now."
          onRetry={() => void itemsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        hasFilters ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Search className="size-4" />
            </span>
            <h3 className="mt-5 font-display text-2xl tracking-[-0.02em]">Nothing matches.</h3>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Try a different search or loosen the filters.
            </p>
            <Button variant="outline" className="mt-6" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <EmptyState
            title="A place for everything, starting here."
            description={
              canWrite
                ? "Add your first item and record its room, its exact shelf, and as much or as little detail as you like."
                : "This household does not have any inventory items yet."
            }
            actionLabel={canWrite ? "Add items" : undefined}
            onAction={canWrite ? () => openAddItems() : undefined}
          />
        )
      ) : (
        <>
          {view === "grid" ? (
            <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  selection={
                    canWrite
                      ? {
                          selected: selected.has(item.id),
                          onToggle: () => toggleItem(item.id),
                          disabled: item.is_archived,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="surface divide-y divide-border/60 overflow-hidden p-1.5">
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  selection={
                    canWrite
                      ? {
                          selected: selected.has(item.id),
                          onToggle: () => toggleItem(item.id),
                          disabled: item.is_archived,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <div className="mt-8 flex flex-col items-center gap-3">
            <p className="text-[0.72rem] text-muted-foreground">
              Showing {items.length} of {total}
            </p>
            {itemsQuery.hasNextPage && (
              <Button
                variant="outline"
                onClick={() => void itemsQuery.fetchNextPage()}
                disabled={itemsQuery.isFetchingNextPage}
              >
                {itemsQuery.isFetchingNextPage ? "Loading…" : "Load more items"}
              </Button>
            )}
          </div>
        </>
      )}

      <BulkMoveDialog
        open={bulkDialog === "move"}
        onOpenChange={(open) => setBulkDialog(open ? "move" : null)}
        items={selectedItems}
        onCompleted={(result) => {
          setSelected(new Set());
          setSelectionNotice(
            `Moved ${pluralize(result.moved_count, "item")}. Each moved item has its own history entry and can be undone individually.`,
          );
        }}
      />
      <BulkTagDialog
        open={bulkDialog === "tags"}
        onOpenChange={(open) => setBulkDialog(open ? "tags" : null)}
        items={selectedItems}
        onCompleted={(result) => {
          setSelected(new Set());
          setSelectionNotice(
            `${result.mode === "add" ? "Added" : "Removed"} tags on ${pluralize(
              result.updated_count,
              "item",
            )}.`,
          );
        }}
      />
      <BulkCategoryDialog
        open={bulkDialog === "category"}
        onOpenChange={(open) => setBulkDialog(open ? "category" : null)}
        items={selectedItems}
        onCompleted={(result) => {
          setSelected(new Set());
          setSelectionNotice(
            result.mode === "set"
              ? `Set category on ${pluralize(result.updated_count, "item")}.`
              : `Cleared category on ${pluralize(result.updated_count, "item")}.`,
          );
        }}
      />
    </div>
  );
}

function ItemGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="overflow-hidden rounded-2xl border border-border/70">
          <Skeleton className="aspect-[4/3] rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

