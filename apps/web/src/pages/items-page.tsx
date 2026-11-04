import { Camera, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useDebouncedValue } from "@/hooks/use-debounced-value";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCategories,
  useItems,
  useLocations,
  useRooms,
  useTags,
} from "@/lib/queries";
import {
  flattenLocations,
  flattenRoomTree,
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
  const [searchParams, setSearchParams] = useSearchParams();
  const qParam = searchParams.get("q") ?? "";
  const roomFilter = searchParams.get("room_id") ?? "";
  const locationFilter = searchParams.get("location_id") ?? "";
  const categoryFilter = searchParams.get("category_id") ?? "";
  const tagFilter = searchParams.get("tag_id") ?? "";
  const archived = searchParams.get("archived") === "1";
  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "created_desc";

  const [search, setSearch] = useState(qParam);
  const debouncedSearch = useDebouncedValue(search, 300);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations(roomFilter || undefined);
  const categoriesQuery = useCategories();
  const tagsQuery = useTags();

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
    include_archived: archived,
    include_descendants: true,
    sort,
  };
  const itemsQuery = useItems(filters, 24);
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = itemsQuery.data?.pages[0]?.total ?? 0;
  const hasFilters = Boolean(
    qParam || roomFilter || locationFilter || categoryFilter || tagFilter || archived,
  );
  const roomOptions = flattenRoomTree(roomsQuery.data?.items ?? []);
  const locationOptions = flattenLocations(locationsQuery.data?.items ?? []);

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
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const updateRoomFilter = (roomId: string) => {
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
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/scan">
                <Camera />
                AI Scan Items
              </Link>
            </Button>
            <Button asChild>
              <Link to="/items/new">
                <Plus />
                Add an item
              </Link>
            </Button>
          </>
        }
      />

      <div className="surface mb-8 p-3.5 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
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
                    .map((entry) => entry.name)
                    .join(" / ")}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-[145px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(event) => updateParam("category_id", event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              <option value="">All categories</option>
              {(categoriesQuery.data?.items ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-[145px] shrink-0 sm:min-w-0">
            <Select
              aria-label="Filter by tag"
              value={tagFilter}
              onChange={(event) => updateParam("tag_id", event.target.value)}
              className="h-9 rounded-lg text-[0.8rem]"
            >
              <option value="">All tags</option>
              {(tagsQuery.data?.items ?? []).map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
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
              Clear
            </Button>
          )}
        </div>
      </div>

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
            description="Add your first item and record its room, its exact shelf, and as much or as little detail as you like."
            actionLabel="Add your first item"
            actionTo="/items/new"
          />
        )
      ) : (
        <>
          <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
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

