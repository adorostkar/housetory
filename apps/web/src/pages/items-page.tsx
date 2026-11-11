import {
  ChevronDown,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { usePropertyFilter } from "@/hooks/use-property-filter";
import { useMediaQuery } from "@/hooks/use-media-query";

import { AddItemsButton, useAddItems } from "@/components/add-items";
import {
  BulkItemActionBar,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemCard, ItemRow } from "@/components/item-card";
import { useItemsView, ViewToggle } from "@/components/view-toggle";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import {
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
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { propertyId, setPropertyId, properties } = usePropertyFilter();
  const qParam = searchParams.get("q") ?? "";
  const roomFilter = searchParams.get("room_id") ?? "";
  const locationFilter = searchParams.get("location_id") ?? "";
  const categoryFilter = searchParams.get("category_id") ?? "";
  const tagFilter = searchParams.get("tag_id") ?? "";
  const purchaseInfo = searchParams.get("purchase_info") ?? "";
  const archived = searchParams.get("archived") === "1";
  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "created_desc";

  const [view, setView] = useItemsView();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const desktopFilters = useMediaQuery("(min-width: 640px)");
  const filterOptionsVisible = desktopFilters || filtersOpen;
  const roomsQuery = useRooms(propertyId || undefined);
  const locationsQuery = useLocations(
    roomFilter || undefined,
    Boolean(roomFilter) && (filterOptionsVisible || Boolean(locationFilter)),
  );
  const categoriesQuery = useCategories(filterOptionsVisible || Boolean(categoryFilter));
  const tagsQuery = useTags(filterOptionsVisible || Boolean(tagFilter));

  const filters = {
    q: qParam || undefined,
    property_id: propertyId || undefined,
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
    propertyId,
    roomFilter,
    locationFilter,
    categoryFilter,
    tagFilter,
    purchaseInfo,
    archived,
    sort,
  ]);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
  });
  const origin = itemOrigin(`${location.pathname}${location.search}`, "Items");
  useRestoreListScroll(items.length > 0, origin);
  const hasFilters = Boolean(
    qParam ||
      propertyId ||
      roomFilter ||
      locationFilter ||
      categoryFilter ||
      tagFilter ||
      purchaseInfo ||
      archived,
  );

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
    propertyId
      ? {
          key: "property",
          label: `Property: ${
            properties.find((property) => property.id === propertyId)?.name ?? "Selected"
          }`,
          remove: () => updatePropertyFilter(""),
        }
      : null,
    qParam
      ? {
          key: "q",
          label: `Search: ${qParam}`,
          remove: () => updateParam("q", ""),
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
    selection.clearSelection("Selection cleared because the view changed.");
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const updatePropertyFilter = (propertyIdValue: string) => {
    selection.clearSelection("Selection cleared because the view changed.");
    setPropertyId(propertyIdValue);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("room_id");
        next.delete("location_id");
        return next;
      },
      { replace: true },
    );
  };

  const updateRoomFilter = (roomId: string) => {
    selection.clearSelection("Selection cleared because the view changed.");
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (roomId) next.set("room_id", roomId);
      else next.delete("room_id");
      next.delete("location_id");
      return next;
    });
  };

  const clearFilters = () => {
    selection.clearSelection("Selection cleared because the view changed.");
    setPropertyId("");
    setSearchParams({}, { replace: true });
  };

  return (
    <PageLayout
      header={{
        eyebrow: "Collection",
        title: "Items",
        description: itemsQuery.data
          ? `${pluralize(total, "item")} recorded${hasFilters ? " matching your filters" : " across your home"}.`
          : "Everything in your home, in one considered place.",
        actionsClassName: "hidden lg:flex",
        actions: (
          <AddItemsButton
            context={propertyId ? { propertyId } : undefined}
          />
        ),
      }}
    >
      <div className="surface mb-4 px-3.5 py-1.5 sm:mb-8 sm:p-4">
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 text-2xs text-muted-foreground sm:pointer-events-none sm:min-h-0 sm:w-auto"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-3.5" />
          <span>Filters</span>
          {activeFilterChips.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-2xs sm:hidden">
              {activeFilterChips.length}
            </Badge>
          )}
          <ChevronDown
            className={`ml-auto size-4 transition-transform sm:hidden ${filtersOpen ? "rotate-180" : ""}`}
          />
        </button>

        <div
          className={`mt-3 grid-cols-2 gap-2 sm:grid sm:grid-cols-3 lg:grid-cols-7 ${filtersOpen ? "grid" : "hidden"}`}
        >
          <div className="min-w-[150px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by property"
              value={propertyId}
              onChange={(event) => updatePropertyFilter(event.target.value)}
              className="h-9 rounded-lg text-xs"
            >
              <option value="">All properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[145px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by room"
              value={roomFilter}
              onChange={(event) => updateRoomFilter(event.target.value)}
              className="h-9 rounded-lg text-xs"
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
              className="h-9 rounded-lg text-xs"
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
                className="h-9 rounded-lg text-xs"
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
            <div className="flex min-w-[145px] shrink-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-2xs text-muted-foreground sm:min-w-0">
              No categories yet
            </div>
          )}

          {tagOptions.length > 0 ? (
            <div className="min-w-[145px] shrink-0 sm:min-w-0">
              <Select
                aria-label="Filter by tag"
                value={tagFilter}
                onChange={(event) => updateParam("tag_id", event.target.value)}
                className="h-9 rounded-lg text-xs"
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
            <div className="flex min-w-[145px] shrink-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-2xs text-muted-foreground sm:min-w-0">
              No tags yet
            </div>
          )}

          <div className="min-w-[165px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by purchase information"
              value={purchaseInfo}
              onChange={(event) => updateParam("purchase_info", event.target.value)}
              className="h-9 rounded-lg text-xs"
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
              className="h-9 rounded-lg text-xs"
            >
              {Object.entries(SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <label className="flex h-9 min-w-[120px] shrink-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-xs text-muted-foreground sm:min-w-0">
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
                className="gap-1 py-1 pl-2.5 pr-1.5 text-2xs"
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
              className="ml-1 text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Reset all filters
            </button>
          </div>
        )}
      </div>

      <BulkSelectionNotice selection={selection} />

      {items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <BulkSelectionControls
            selection={selection}
            showing={items.length}
            total={total}
          />
          <ViewToggle view={view} onChange={setView} />
        </div>
      )}

      <BulkItemActionBar
        items={selection.selectedItems}
        onClear={() => selection.clearSelection()}
        onNotice={selection.showNotice}
      />

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
                          selected: selection.selected.has(item.id),
                          onToggle: () => selection.toggleItem(item.id),
                          disabled: item.is_archived,
                        }
                      : undefined
                  }
                  origin={origin}
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
                          selected: selection.selected.has(item.id),
                          onToggle: () => selection.toggleItem(item.id),
                          disabled: item.is_archived,
                        }
                      : undefined
                  }
                  origin={origin}
                />
              ))}
            </div>
          )}
          <div className="mt-8 flex flex-col items-center gap-3">
            <p className="text-2xs text-muted-foreground">
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

    </PageLayout>
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

