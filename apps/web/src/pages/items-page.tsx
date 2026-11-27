import {
  ChevronDown,
  ClipboardCheck,
  HandCoins,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { usePropertyFilter } from "@/hooks/use-property-filter";

import { useAddItems, useRegisterAddItemsContext } from "@/components/add-items";
import {
  BulkItemActionBar,
  BulkSelectButton,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { FirstRunChecklist } from "@/components/first-run-checklist";
import { ItemCard, ItemRow } from "@/components/item-card";
import { RoomDialog } from "@/components/room-dialog";
import { useItemsView, ViewToggle } from "@/components/view-toggle";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCanWrite,
  useCaptureReviews,
  useCategories,
  useItems,
  useItemsByIds,
  useLocations,
  useOverview,
  usePendingActions,
  useReviewSummary,
  useRooms,
  useSession,
  useTags,
} from "@/lib/queries";
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import {
  keepRecentItemsSnapshot,
  mergeRecentItems,
  recentItemsSnapshot,
  type RecentItemsMap,
} from "@/lib/recent-items";
import {
  cn,
  flattenLocations,
  flattenRoomTree,
  locationLabel,
  locationPath,
  roomPath,
} from "@/lib/utils";

/** "recent" is worked out on this device; the others are orders the server knows. */
const SORTS = {
  recent: "Recent",
  created_desc: "Newest",
  name_asc: "Name",
  location_asc: "Location",
} as const;

/** Still accepted from an old link, and shown in the control only while in use. */
const LINKED_SORTS = {
  name_desc: "Name Z–A",
  updated_desc: "Recently updated",
} as const;

type SortKey = keyof typeof SORTS | keyof typeof LINKED_SORTS;

function isSortKey(value: string | null): value is SortKey {
  return value !== null && (value in SORTS || value in LINKED_SORTS);
}

const SORT_STORAGE_PREFIX = "housetory:items-sort:";

function rememberedSort(userId: string | undefined): SortKey {
  try {
    const stored = localStorage.getItem(`${SORT_STORAGE_PREFIX}${userId ?? ""}`);
    if (stored !== null && stored in SORTS) return stored as SortKey;
  } catch {
    // Storage may be unavailable; the default order is used.
  }
  return "recent";
}

export function ItemsPage() {
  const { openAddItems } = useAddItems();
  const canWrite = useCanWrite();
  const location = useLocation();
  const session = useSession().data;
  const userId = session?.user?.id;
  const householdId = session?.household?.id;
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
  const [storedSort, setStoredSort] = useState<SortKey>(() => rememberedSort(userId));
  // A sort in the link wins. Otherwise the order this person chose last time.
  const sort: SortKey = isSortKey(sortParam) ? sortParam : storedSort;
  // A search is ordered by how well the name matches, so "Recent" does not apply to it.
  const recentOrder = sort === "recent" && !qParam;

  const [view, setView] = useItemsView();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const filterOptionsVisible = filtersOpen;
  useRegisterAddItemsContext(propertyId ? { propertyId } : null);
  const overview = useOverview();
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
    sort: sort === "recent" ? ("created_desc" as const) : sort,
  };
  const itemsQuery = useItems(filters, 24);
  const loaded = useMemo(
    () => itemsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [itemsQuery.data],
  );
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

  // The opening times are read once for a view and then held, so the list does not
  // move when an item is opened and the user comes back. See lib/recent-items.ts.
  const recentScope = useMemo(
    () => (userId && householdId ? { userId, householdId } : null),
    [userId, householdId],
  );
  const snapshotKey = `${userId ?? ""}:${householdId ?? ""}:${filterSignature}`;
  const snapshot = useRef<{ key: string; openedAt: RecentItemsMap } | null>(null);
  if (snapshot.current?.key !== snapshotKey) {
    snapshot.current = {
      key: snapshotKey,
      openedAt: recentOrder ? recentItemsSnapshot(recentScope, filterSignature) : {},
    };
  }
  const openedAt = snapshot.current.openedAt;
  useEffect(() => {
    if (recentOrder) keepRecentItemsSnapshot(recentScope, filterSignature, openedAt);
  }, [recentOrder, recentScope, filterSignature, openedAt]);
  const recentIds = useMemo(() => Object.keys(openedAt).sort(), [openedAt]);
  const recentQuery = useItemsByIds(filters, recentIds, recentOrder);
  const hasNextPage = Boolean(itemsQuery.hasNextPage);
  const items = useMemo(
    () =>
      recentOrder && recentQuery.data
        ? mergeRecentItems(loaded, recentQuery.data.items, openedAt, hasNextPage)
        : loaded,
    [recentOrder, recentQuery.data, loaded, openedAt, hasNextPage],
  );
  // Both lists are needed before the first paint, or rows would jump into place.
  const listPending =
    itemsQuery.isPending || (recentOrder && recentIds.length > 0 && recentQuery.isPending);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
    onRequest: true,
  });
  useRegisterAssistantPageContext(
    selection.selectedItems.map((item) => ({ kind: "item", id: item.id, name: item.name })),
  );
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

  const changeSort = (value: string) => {
    if (!isSortKey(value)) return;
    selection.clearSelection("Selection cleared because the view changed.");
    if (value in SORTS) {
      setStoredSort(value);
      try {
        localStorage.setItem(`${SORT_STORAGE_PREFIX}${userId ?? ""}`, value);
      } catch {
        // The choice still applies until the page is left.
      }
    }
    if (sortParam === null) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("sort");
        return next;
      },
      { replace: true },
    );
  };

  const activeFilterCount = activeFilterChips.filter((chip) => chip.key !== "q").length;
  const sortOptions = Object.entries({
    ...SORTS,
    ...(sort in LINKED_SORTS ? { [sort]: LINKED_SORTS[sort as keyof typeof LINKED_SORTS] } : {}),
  });

  return (
    <div className="animate-fade-up">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <PageHeader title="All items" className="mb-0 min-w-0 sm:mb-0" />
          {itemsQuery.data && (
            <p className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {total}
              <span className="sr-only"> {total === 1 ? "item" : "items"}</span>
              {hasFilters ? " matching" : ""}
            </p>
          )}
        </div>
        {canWrite && items.length > 0 && <BulkSelectButton selection={selection} />}
      </div>

      {/* One row of tools. It only wraps on the narrowest phones with the rooms open. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {qParam ? (
          <p className="flex min-h-11 items-center pr-1 text-xs text-muted-foreground">
            Best matches first
          </p>
        ) : (
          <div className="w-[6.5rem] shrink-0 sm:w-32">
            <Select
              aria-label="Sort items"
              value={sort}
              onChange={(event) => changeSort(event.target.value)}
              className="rounded-lg pl-2.5 pr-7 text-sm [&+svg]:right-2"
            >
              {sortOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <button
          type="button"
          className="relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-input/90 bg-card/65 px-2.5 text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={filtersOpen}
          aria-controls="item-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          {/* On phones the icon stands for the word, which stays in the accessible name. */}
          <span className="sr-only sm:not-sr-only">Filters</span>
          {activeFilterCount > 0 && (
            <Badge
              variant="secondary"
              className="absolute -right-1.5 -top-1.5 border-background px-1.5 py-0 text-2xs sm:static sm:border-transparent"
            >
              <span className="sr-only">Active filters: </span>
              {activeFilterCount}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "hidden size-4 text-muted-foreground transition-transform sm:block",
              filtersOpen && "rotate-180",
            )}
          />
        </button>
        {/* Phone: the view buttons end the row and the notice gets its own row below.
            Wider: the notice and the view buttons sit together at the right end. */}
        <div className="contents sm:ml-auto sm:flex sm:items-center sm:gap-2">
          <ListNotices className="order-last w-full sm:order-none sm:w-auto" />
          {items.length > 0 && (
            <div className="ml-auto sm:ml-0">
              <ViewToggle view={view} onChange={setView} />
            </div>
          )}
        </div>
      </div>

      <div
        className={cn(
          "surface mb-4 p-3.5",
          !filtersOpen && activeFilterChips.length === 0 && "hidden",
        )}
      >
        <div
          id="item-filters"
          className={cn(
            "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2",
            filtersOpen ? "grid" : "hidden",
          )}
        >
          <div className="min-w-0">
            <Select
              aria-label="Filter by property"
              value={propertyId}
              onChange={(event) => updatePropertyFilter(event.target.value)}
              className="rounded-lg text-sm"
            >
              <option value="">All properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Select
              aria-label="Filter by room"
              value={roomFilter}
              onChange={(event) => updateRoomFilter(event.target.value)}
              className="rounded-lg text-sm"
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

          <div className="min-w-0">
            <Select
              aria-label="Filter by storage location"
              value={locationFilter}
              disabled={!roomFilter}
              onChange={(event) => updateParam("location_id", event.target.value)}
              className="rounded-lg text-sm"
            >
              <option value="">All places</option>
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
            <div className="min-w-0">
              <Select
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(event) => updateParam("category_id", event.target.value)}
                className="rounded-lg text-sm"
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
            <div className="flex min-h-11 min-w-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-2xs text-muted-foreground">
              No categories yet
            </div>
          )}

          {tagOptions.length > 0 ? (
            <div className="min-w-0">
              <Select
                aria-label="Filter by tag"
                value={tagFilter}
                onChange={(event) => updateParam("tag_id", event.target.value)}
                className="rounded-lg text-sm"
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
            <div className="flex min-h-11 min-w-0 items-center rounded-lg border border-dashed border-border/70 px-3 text-2xs text-muted-foreground">
              No tags yet
            </div>
          )}

          <div className="min-w-0">
            <Select
              aria-label="Filter by purchase information"
              value={purchaseInfo}
              onChange={(event) => updateParam("purchase_info", event.target.value)}
              className="rounded-lg text-sm"
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

          <label className="flex h-11 min-w-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-sm text-muted-foreground">
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
              className="h-11 justify-start text-muted-foreground"
            >
              <X />
              Clear all
            </Button>
          )}
        </div>

        {activeFilterChips.length > 0 && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-1.5",
              filtersOpen && "mt-3 border-t border-border/60 pt-3",
            )}
          >
            {activeFilterChips.map((chip) => (
              <Badge
                key={chip.key}
                variant="secondary"
                className="max-w-full gap-1 py-0 pl-2.5 pr-0 text-2xs"
              >
                <span className="min-w-0 max-w-64 truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={chip.remove}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:size-7 coarse:!size-11"
                  aria-label={`Remove ${chip.label}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 min-h-11 text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-0 coarse:!min-h-11"
            >
              Reset all filters
            </button>
          </div>
        )}
      </div>

      <BulkSelectionNotice selection={selection} />

      {items.length > 0 && selection.selecting && (
        <div className="mb-2">
          <BulkSelectionControls
            selection={selection}
            showing={items.length}
            total={total}
          />
        </div>
      )}

      {/* Clear, and finishing an action, also leave selection mode. */}
      <BulkItemActionBar
        items={selection.selectedItems}
        onClear={selection.stopSelecting}
        onNotice={selection.showNotice}
      />

      {listPending ? (
        <ItemListSkeleton view={view} />
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
        ) : canWrite ? (
          <FirstRunChecklist
            roomCount={overview.data?.room_count ?? roomsQuery.data?.items.length ?? 0}
            itemCount={0}
            documentCount={overview.data?.document_count ?? 0}
            onCreateRoom={() => setRoomDialogOpen(true)}
            onAddItems={() => openAddItems()}
          />
        ) : (
          <EmptyState
            title="A place for everything, starting here."
            description="This household does not have any inventory items yet."
          />
        )
      ) : (
        <>
          {view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3.5 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] sm:gap-4">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  selection={selection.itemSelection(item)}
                  origin={origin}
                />
              ))}
            </div>
          ) : (
            <div className="surface divide-y divide-border/60 overflow-hidden p-1">
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  selection={selection.itemSelection(item)}
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

      {/* Room for the selection bar, so it never hides the end of the list. */}
      {selection.selectedItems.length > 0 && <div aria-hidden="true" className="h-24" />}

      <RoomDialog
        open={roomDialogOpen}
        onOpenChange={setRoomDialogOpen}
        rooms={roomsQuery.data?.items ?? []}
        defaultPropertyId={propertyId || undefined}
      />
    </div>
  );
}

/**
 * Things that need a look, in one short row. Nothing is shown when there is
 * nothing to do.
 */
function ListNotices({ className }: { className?: string }) {
  const reviewSummary = useReviewSummary();
  const captures = useCaptureReviews();
  const pendingActions = usePendingActions();
  const overview = useOverview();
  const findings =
    (reviewSummary.data?.pending_count ?? 0) +
    (captures.data?.length ?? 0) +
    (pendingActions.data?.total ?? 0);
  const pastDue = overview.data?.overdue_loan_count ?? 0;
  const expiring = overview.data?.warranties?.expiring_count ?? 0;
  if (findings + pastDue + expiring === 0) return null;
  const notice =
    "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9 coarse:!min-h-11";
  return (
    <ul
      aria-label="Things to look at"
      data-testid="list-notices"
      className={cn("flex flex-wrap items-center gap-2 sm:justify-end", className)}
    >
      {findings > 0 && (
        <li>
          <Link
            to="/review"
            className={cn(notice, "border-brass/30 bg-brass-soft/40 text-foreground hover:bg-brass-soft/70")}
          >
            <ClipboardCheck className="size-3.5 text-brass" aria-hidden="true" />
            {findings} {findings === 1 ? "finding" : "findings"} to review
          </Link>
        </li>
      )}
      {pastDue > 0 && (
        <li>
          <Link
            to="/loans?overdue=1"
            className={cn(notice, "border-border/70 bg-card/60 text-foreground hover:bg-secondary/60")}
          >
            <HandCoins className="size-3.5 text-brass" aria-hidden="true" />
            {pastDue} {pastDue === 1 ? "loan" : "loans"} past due
          </Link>
        </li>
      )}
      {expiring > 0 && (
        <li>
          <Link
            to="/warranties?status=expiring"
            className={cn(notice, "border-border/70 bg-card/60 text-foreground hover:bg-secondary/60")}
          >
            <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {expiring} {expiring === 1 ? "warranty" : "warranties"} expiring
          </Link>
        </li>
      )}
    </ul>
  );
}

function ItemListSkeleton({ view }: { view: "grid" | "list" }) {
  if (view === "list") {
    return (
      <div className="surface space-y-1 p-1" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 px-2 py-2">
            <Skeleton className="size-12 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3.5 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] sm:gap-4">
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
