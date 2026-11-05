import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Boxes,
  ListFilter,
  MapPin,
  Package,
  Search as SearchIcon,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { api, getApiErrorMessage } from "@/lib/api";
import type { NaturalSearchResponse, QuickSearchResult } from "@/lib/types";

import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useItems, useQuickSearch } from "@/lib/queries";
import { looksLikeQuestion } from "@/lib/search";
import { pluralize } from "@/lib/utils";

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qParam = searchParams.get("q") ?? "";
  const askMode =
    searchParams.get("ask") === "1" || searchParams.get("mode") === "smart";
  const [query, setQuery] = useState(qParam);
  const debounced = useDebouncedValue(query, 350);
  const trimmed = debounced.trim();
  const hasQuery = qParam.trim().length > 0;
  const placesQuery = useQuickSearch(
    qParam,
    8,
    hasQuery && !askMode,
  );
  const searchQuery = useItems(
    { q: qParam || undefined },
    30,
    qParam.trim().length > 0 && !askMode,
  );
  const naturalQuery = useQuery({
    queryKey: ["search", "natural", qParam, 40],
    queryFn: ({ signal }) =>
      api.post<NaturalSearchResponse>(
        "/search/natural",
        { question: qParam, limit: 40 },
        { signal },
      ),
    enabled: askMode && qParam.trim().length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  const results = searchQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = searchQuery.data?.pages[0]?.total ?? 0;
  const answer = naturalQuery.data;
  const placeResults = (placesQuery.data?.results ?? []).filter(
    (result) => result.kind !== "item",
  );
  const placesPending = !askMode && hasQuery && placesQuery.isPending;
  const pending = askMode ? naturalQuery.isPending : searchQuery.isPending;
  const isError = askMode ? naturalQuery.isError : searchQuery.isError;
  const error = askMode ? naturalQuery.error : searchQuery.error;
  const interpretedQuery = placesQuery.data?.effective_query ?? null;

  useEffect(() => {
    setQuery(qParam);
  }, [qParam]);

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

  const setAskMode = (next: boolean) => {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.delete("mode");
        if (next) params.set("ask", "1");
        else params.delete("ask");
        return params;
      },
      { replace: true },
    );
  };

  const submit = (ask?: boolean) => {
    const value = query.trim();
    if (value.length < 2) return;
    const shouldAsk = ask ?? looksLikeQuestion(value);
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set("q", value);
        params.delete("mode");
        if (shouldAsk) params.set("ask", "1");
        else params.delete("ask");
        return params;
      },
      { replace: true },
    );
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    if (!askMode) return;
    // Typing a new query drops the previous answer and returns to ordinary
    // keyword results; no inference is triggered until the user submits again.
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.delete("ask");
        params.delete("mode");
        return params;
      },
      { replace: true },
    );
  };

  const naturalErrorRetry = () => void naturalQuery.refetch();

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Search"
        title="Find anything"
        description="Search names, brands, serial numbers, tags, rooms and storage places — or ask a question about your inventory."
      />

      <div className="mx-auto mb-3 flex max-w-3xl justify-center">
        <div className="inline-flex rounded-full border border-border/70 bg-card/60 p-1">
          <button
            type="button"
            onClick={() => setAskMode(false)}
            aria-pressed={!askMode}
            className={
              !askMode
                ? "inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[0.72rem] font-medium text-primary-foreground"
                : "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] text-muted-foreground"
            }
          >
            <ListFilter className="size-3.5" /> Keyword results
          </button>
          <button
            type="button"
            onClick={() => (query.trim() ? submit(true) : setAskMode(true))}
            aria-pressed={askMode}
            className={
              askMode
                ? "inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[0.72rem] font-medium text-primary-foreground"
                : "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[0.72rem] text-muted-foreground"
            }
          >
            <Sparkles className="size-3.5" /> Ask Housetory
          </button>
        </div>
      </div>

      <div className="relative mx-auto max-w-3xl">
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
          placeholder="Search or ask about your inventory…"
          aria-label="Search or ask about your inventory"
          maxLength={1000}
          className="h-16 rounded-2xl border-border/80 bg-card/80 pl-14 pr-16 text-lg shadow-soft"
        />
        <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[0.65rem] font-medium text-muted-foreground sm:block">
          ⌘K
        </kbd>
      </div>

      <div className="mx-auto mt-4 flex max-w-3xl flex-wrap items-center justify-between gap-2 text-[0.72rem] text-muted-foreground">
        <p>Search for an item or ask a question.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => submit(false)}>
            <SearchIcon /> Search
          </Button>
          <Button size="sm" onClick={() => submit(true)}>
            <Sparkles /> Ask Housetory
          </Button>
        </div>
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
            <p className="mt-2 max-w-md text-pretty text-[0.85rem] leading-relaxed text-muted-foreground">
              Try a brand, model, serial number, room, storage place or tag. For
              questions such as “Where is my heavy drill?” or “Which items have no
              purchase information?”, press Enter or choose Ask Housetory.
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
            <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
              {[
                "Where is my heavy drill?",
                "Which items have no purchase information?",
                "What is on loan?",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setQuery(example);
                    setSearchParams(
                      { q: example, ask: "1" },
                      { replace: true },
                    );
                  }}
                  className="rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-[0.72rem] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : askMode ? (
          naturalQuery.isPending ? (
            <AnswerSkeleton />
          ) : naturalQuery.isError ? (
            <ErrorState
              title="The assistant could not answer just now"
              message={getApiErrorMessage(error)}
              onRetry={naturalErrorRetry}
            />
          ) : answer ? (
            <AnswerResults
              answer={answer}
              onAskAgain={() => void naturalQuery.refetch()}
              onKeyword={() => setAskMode(false)}
            />
          ) : (
            <AnswerSkeleton />
          )
        ) : pending || (results.length === 0 && placesPending) ? (
          <SearchSkeleton />
        ) : isError ? (
          <ErrorState
            title="Search is out of reach"
            message={getApiErrorMessage(error)}
            onRetry={() => void searchQuery.refetch()}
          />
        ) : results.length === 0 && placeResults.length === 0 ? (
          <div className="surface flex flex-col items-center px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <SearchIcon className="size-5" strokeWidth={1.6} />
            </span>
            <h2 className="mt-5 font-display text-2xl tracking-[-0.02em]">
              Nothing found for “{qParam}”
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Check the spelling, try a shorter phrase, or ask the assistant to
              interpret the question against your records.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => submit(true)}>
                <Sparkles /> Ask Housetory
              </Button>
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
                {results.length > 0
                  ? pluralize(total, "result")
                  : pluralize(placeResults.length, "matching place")}{" "}
                for “{qParam}”
              </p>
              {interpretedQuery && (
                <p className="text-[0.7rem] text-muted-foreground">
                  Matched the item words “{interpretedQuery}” from your question.
                </p>
              )}
            </div>
            {results.length > 0 && (
              <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
                {results.map((item) => (
                  <ItemCard key={item.id} item={item} />
                ))}
              </div>
            )}
            {placeResults.length > 0 && (
              <section className="mt-8" aria-label="Matching containers and locations">
                <div className="mb-3 flex items-center gap-2">
                  <Boxes className="size-4 text-brass" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    Places and containers
                  </h2>
                </div>
                <div className="surface divide-y divide-border/60 overflow-hidden">
                  {placeResults.map((result) => (
                    <PlaceResult key={`${result.kind}-${result.id}`} result={result} />
                  ))}
                </div>
              </section>
            )}
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

function AnswerResults({
  answer,
  onAskAgain,
  onKeyword,
}: {
  answer: NaturalSearchResponse;
  onAskAgain: () => void;
  onKeyword: () => void;
}) {
  const filterLink = contextualFilterLink(answer);
  const filterLabel =
    answer.tool === "locate_item"
      ? "Open item"
      : answer.tool === "find_missing_information"
        ? "Open matching filters"
        : "Open matching records";
  const answerItems = answer.items;
  const showInterpretation =
    answer.tool === "search_items" &&
    Boolean(answer.interpretation) &&
    answer.interpretation !== "keyword search";
  return (
    <div className="space-y-5">
      <section className="surface p-5 sm:p-6">
        {showInterpretation && (
          <p className="text-[0.7rem] text-muted-foreground">
            {answer.interpretation}
          </p>
        )}
        <p
          className={
            showInterpretation
              ? "mt-2 whitespace-pre-line text-[0.9rem] leading-[1.75] text-foreground/90"
              : "whitespace-pre-line text-[0.9rem] leading-[1.75] text-foreground/90"
          }
        >
          {answer.answer ||
            "Housetory found matching records below and did not invent an answer."}
        </p>
        {answer.notices.length > 0 && (
          <ul className="mt-3 space-y-1 text-[0.74rem] leading-relaxed text-muted-foreground">
            {answer.notices.map((notice) => (
              <li key={notice}>• {notice}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" asChild>
            <Link
              to={`/assistant?q=${encodeURIComponent(answer.question)}`}
            >
              Continue in Assistant <ArrowRight />
            </Link>
          </Button>
          {filterLink && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={filterLink}>{filterLabel}</Link>
            </Button>
          )}
          {answer.needs_assistant && (
            <Button size="sm" asChild>
              <Link to={`/assistant?q=${encodeURIComponent(answer.question)}`}>
                Ask Housetory
              </Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onKeyword}>
            Keyword results
          </Button>
          <Button size="sm" variant="ghost" onClick={onAskAgain}>
            Ask again
          </Button>
        </div>
      </section>

      {answer.references.length > 0 && (
        <section aria-label="Sources" className="flex flex-wrap gap-1.5">
          {answer.references.slice(0, 12).map((reference) => (
            <Link key={`${reference.type}-${reference.id}`} to={reference.url}>
              <Badge variant="outline" className="hover:bg-secondary">
                {reference.title}
              </Badge>
            </Link>
          ))}
        </section>
      )}

      {answerItems.length > 0 ? (
        <section aria-label="Matching items">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
              {pluralize(answer.total, "matching item")}
            </h2>
            <p className="text-[0.7rem] text-muted-foreground">
              Current household records only.
            </p>
          </div>
          <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
            {answerItems.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ) : (
        <div className="surface px-5 py-4 text-[0.78rem] leading-relaxed text-muted-foreground">
          No matching item records were returned. The answer above is based on the
          recorded filters and loan state, not on a model's memory.
        </div>
      )}
    </div>
  );
}

function contextualFilterLink(answer: NaturalSearchResponse): string | null {
  if (answer.tool === "find_missing_information") {
    const criterion = String(answer.facts.criterion ?? "");
    if (criterion === "missing_purchase") {
      return "/items?purchase_info=missing";
    }
    if (criterion === "missing_purchase_date") {
      return "/items?purchase_info=missing_date";
    }
    if (criterion === "missing_purchase_price") {
      return "/items?purchase_info=missing_price";
    }
    if (criterion === "purchase_unknown") {
      return "/items?purchase_info=unknown";
    }
    if (criterion === "purchase_not_applicable") {
      return "/items?purchase_info=not_applicable";
    }
    return "/items";
  }
  if (answer.tool === "list_outstanding_loans") return "/loans";
  if (answer.tool === "locate_item" && answer.facts.whereabouts) {
    const whereabouts = answer.facts.whereabouts as { item_id?: string };
    if (whereabouts.item_id) return `/items/${whereabouts.item_id}`;
  }
  if (answer.tool === "get_warranty_status") return "/warranties";
  if (answer.tool === "search_documents") return "/documents";
  if (answer.tool === "get_purchase_history") return "/purchases";
  return null;
}

function PlaceResult({ result }: { result: QuickSearchResult }) {
  const Icon = result.kind === "container" ? Boxes : MapPin;
  const label = result.kind === "container" ? "Container" : "Location";
  return (
    <Link
      to={result.url}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[0.84rem] font-medium">{result.title}</span>
          <Badge
            variant={result.kind === "container" ? "brass" : "outline"}
            className="text-[0.6rem]"
          >
            {label}
          </Badge>
        </span>
        <span className="mt-0.5 block truncate text-[0.7rem] text-muted-foreground">
          {[result.subtitle, result.context].filter(Boolean).join(" · ") || "Housetory"}
        </span>
      </span>
    </Link>
  );
}

function AnswerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="surface space-y-3 p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-9 w-44" />
      </div>
      <SearchSkeleton />
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
