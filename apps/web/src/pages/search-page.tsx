import { useMutation } from "@tanstack/react-query";
import { ListFilter, Package, Search as SearchIcon, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { api, getApiErrorMessage } from "@/lib/api";
import type { NaturalSearchResponse } from "@/lib/types";

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
  const [mode, setMode] = useState<"keyword" | "smart">(
    searchParams.get("mode") === "smart" ? "smart" : "keyword",
  );
  const debounced = useDebouncedValue(query, 350);
  const trimmed = debounced.trim();
  const searchQuery = useItems(
    { q: qParam || undefined },
    30,
    qParam.trim().length > 0 && mode === "keyword",
  );
  const naturalSearch = useMutation({
    mutationFn: (value: string) =>
      api.post<NaturalSearchResponse>("/search/natural", {
        question: value,
        limit: 40,
      }),
  });
  const results =
    mode === "smart"
      ? naturalSearch.data?.items ?? []
      : searchQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total =
    mode === "smart"
      ? naturalSearch.data?.total ?? 0
      : searchQuery.data?.pages[0]?.total ?? 0;

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

  useEffect(() => {
    if (mode !== "smart") return;
    if (trimmed.length < 2) {
      naturalSearch.reset();
      return;
    }
    naturalSearch.mutate(trimmed);
    // The debounced query is the only trigger; mutate is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, mode]);

  const switchMode = (next: "keyword" | "smart") => {
    setMode(next);
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (next === "smart") params.set("mode", "smart");
        else params.delete("mode");
        return params;
      },
      { replace: true },
    );
  };

  const hasQuery = qParam.trim().length > 0;
  const pending =
    mode === "smart" ? naturalSearch.isPending : searchQuery.isPending;
  const isError =
    mode === "smart" ? naturalSearch.isError : searchQuery.isError;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Search"
        title="Find anything"
        description="Search names, brands, serial numbers, tags, rooms and storage places."
      />

      <div className="mx-auto mb-4 flex max-w-3xl justify-center">
        <div className="inline-flex rounded-full border border-border/70 bg-card/60 p-1">
          <button
            type="button"
            onClick={() => switchMode("keyword")}
            aria-pressed={mode === "keyword"}
            className={
              mode === "keyword"
                ? "inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[0.72rem] font-medium text-primary-foreground"
                : "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] text-muted-foreground"
            }
          >
            <ListFilter className="size-3.5" /> Keyword
          </button>
          <button
            type="button"
            onClick={() => switchMode("smart")}
            aria-pressed={mode === "smart"}
            className={
              mode === "smart"
                ? "inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[0.72rem] font-medium text-primary-foreground"
                : "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] text-muted-foreground"
            }
          >
            <Sparkles className="size-3.5" /> Smart search
          </button>
        </div>
      </div>

      <div className="relative mx-auto max-w-3xl">
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            mode === "smart"
              ? "Find electronics in the attic without purchase records…"
              : "What are you looking for?"
          }
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
              Try a brand, a model, a serial number, a room, a storage place, or a tag.
              Results appear as you type.
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
        ) : pending ? (
          <SearchSkeleton />
        ) : isError ? (
          <ErrorState
            title="Search is out of reach"
            message={getApiErrorMessage(
              mode === "smart" ? naturalSearch.error : searchQuery.error,
            )}
            onRetry={() => {
              if (mode === "smart") naturalSearch.mutate(trimmed);
              else void searchQuery.refetch();
            }}
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
              {mode === "smart"
                ? "The smart interpretation found no matches. Try keyword search or rephrase the request."
                : "Check the spelling, try a shorter phrase, or search by another detail."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {mode === "smart" && (
                <Button variant="outline" onClick={() => switchMode("keyword")}>
                  <ListFilter /> Try keyword search
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery("");
                  setSearchParams({}, { replace: true });
                }}
              >
                Clear search
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-[0.8rem] text-muted-foreground">
                {pluralize(total, "result")} for “{qParam}”
              </p>
              {mode === "smart" && naturalSearch.data && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="brass">
                    <Sparkles className="size-3" /> Smart interpretation
                  </Badge>
                  <span className="text-[0.7rem] text-muted-foreground">
                    {naturalSearch.data.interpretation}
                  </span>
                </div>
              )}
            </div>
            <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
              {results.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
            {mode === "keyword" && searchQuery.hasNextPage && (
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
