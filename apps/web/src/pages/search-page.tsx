import { Package, Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems } from "@/lib/queries";
import { pluralize } from "@/lib/utils";

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qParam = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(qParam);
  const debounced = useDebouncedValue(query, 300);
  const trimmed = debounced.trim();
  const searchQuery = useItems({ q: qParam || undefined }, 30, qParam.trim().length > 0);
  const results = searchQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = searchQuery.data?.pages[0]?.total ?? 0;

  useEffect(() => {
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
  }, [trimmed, qParam, setSearchParams]);

  const hasQuery = qParam.trim().length > 0;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Search"
        title="Find anything"
        description="Search across names, brands, models, serial numbers and tags."
      />

      <div className="relative mx-auto max-w-3xl">
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What are you looking for?"
          aria-label="Search inventory"
          className="h-16 rounded-2xl border-border/80 bg-card/80 pl-14 pr-16 text-lg shadow-soft"
        />
        <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[0.65rem] font-medium text-muted-foreground sm:block">
          ⌘K
        </kbd>
      </div>

      <div className="mx-auto mt-10 max-w-5xl">
        {!hasQuery ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <SearchIcon className="size-5" strokeWidth={1.6} />
            </span>
            <h2 className="mt-5 font-display text-2xl tracking-[-0.02em]">
              Look for something specific
            </h2>
            <p className="mt-2 max-w-sm text-pretty text-[0.85rem] leading-relaxed text-muted-foreground">
              Try a brand, a model, a serial number, or a tag like “camping”. Results
              appear as you type.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/items">
                  <Package />
                  Browse all items
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/rooms">Browse by room</Link>
              </Button>
            </div>
          </div>
        ) : searchQuery.isPending ? (
          <SearchSkeleton />
        ) : searchQuery.isError ? (
          <ErrorState
            title="Search is out of reach"
            message="We couldn't search your inventory just now."
            onRetry={() => void searchQuery.refetch()}
          />
        ) : results.length === 0 ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <SearchIcon className="size-5" strokeWidth={1.6} />
            </span>
            <h2 className="mt-5 font-display text-2xl tracking-[-0.02em]">
              Nothing found for “{qParam}”
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Check the spelling, try a shorter phrase, or search by another detail.
            </p>
            <Button
              variant="outline"
              className="mt-6"
              onClick={() => {
                setQuery("");
                setSearchParams({}, { replace: true });
              }}
            >
              Clear search
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-5 flex items-baseline justify-between gap-4">
              <p className="text-[0.8rem] text-muted-foreground">
                {pluralize(total, "result")} for “{qParam}”
              </p>
            </div>
            <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
              {results.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
            {searchQuery.hasNextPage && (
              <div className="mt-8 flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => void searchQuery.fetchNextPage()}
                  disabled={searchQuery.isFetchingNextPage}
                >
                  {searchQuery.isFetchingNextPage ? "Loading…" : "Load more results"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
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
