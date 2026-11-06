import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Boxes,
  HandCoins,
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
import type {
  BorrowedRecord,
  NaturalSearchResponse,
  QuickSearchResult,
} from "@/lib/types";

import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
import { SearchScopeSelect } from "@/components/search-scope-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useSearchScope } from "@/hooks/use-search-scope";
import { useAllPlacesItems, useQuickSearch } from "@/lib/queries";
import { withHousehold } from "@/lib/household-links";
import { looksLikeQuestion } from "@/lib/search";
import { formatDate, pluralize } from "@/lib/utils";

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { selection, label: scopeLabel } = useSearchScope(true);
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
    selection,
  );
  const searchQuery = useAllPlacesItems(
    {
      q: qParam || undefined,
      household_id: selection.householdId || undefined,
      property_id: selection.propertyId || undefined,
    },
    30,
    qParam.trim().length > 0 && !askMode,
  );
  const naturalQuery = useQuery({
    queryKey: [
      "search",
      "natural",
      qParam,
      40,
      selection.householdId,
      selection.propertyId,
    ],
    queryFn: ({ signal }) =>
      api.post<NaturalSearchResponse>(
        "/search/natural",
        {
          question: qParam,
          limit: 40,
          ...(selection.householdId
            ? { household_id: selection.householdId }
            : {}),
          ...(selection.propertyId ? { property_id: selection.propertyId } : {}),
        },
        { signal },
      ),
    enabled: askMode && qParam.trim().length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  const results = searchQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = searchQuery.data?.pages[0]?.total ?? 0;
  const answer = naturalQuery.data;
  const borrowedResults = (placesQuery.data?.results ?? []).filter(
    (result) => result.kind === "borrowed",
  );
  const placeResults = (placesQuery.data?.results ?? []).filter(
    (result) => result.kind !== "item" && result.kind !== "borrowed",
  );
  const placesPending = !askMode && hasQuery && placesQuery.isPending;
  const borrowedFromItems = searchQuery.data?.pages[0]?.borrowed ?? [];
  const borrowedTotal = searchQuery.data?.pages[0]?.borrowed_total ?? 0;
  const pending = askMode ? naturalQuery.isPending : searchQuery.isPending;
  const isError = askMode ? naturalQuery.isError : searchQuery.isError;
  const error = askMode ? naturalQuery.error : searchQuery.error;
  const interpretedQuery = placesQuery.data?.effective_query ?? null;

  useEffect(() => {
    setQuery(qParam);
  }, [qParam]);

  useEffect(() => {
    if (trimmed === qParam) return;
    // A debounced value older than the current draft must never overwrite an
    // explicit submit or example click. Wait until the debounce has caught up.
    if (query !== trimmed) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [trimmed, query, qParam, setSearchParams]);

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

      <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-center gap-2">
        <SearchScopeSelect compact />
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
        <p>{scopeLabel}</p>
        {askMode ? (
          <Button size="sm" onClick={() => submit(true)}>
            <Sparkles /> Ask Housetory
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => submit(false)}>
            <SearchIcon /> Search
          </Button>
        )}
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
                "What do I need to return?",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setQuery(example);
                    setSearchParams(
                      (previous) => {
                        const params = new URLSearchParams(previous);
                        params.set("q", example);
                        params.set("ask", "1");
                        params.delete("mode");
                        return params;
                      },
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
              scopeLabel={scopeLabel}
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
        ) : results.length === 0 &&
          placeResults.length === 0 &&
          borrowedResults.length === 0 &&
          borrowedFromItems.length === 0 ? (
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
                  setSearchParams(
                    (previous) => {
                      const params = new URLSearchParams(previous);
                      params.delete("q");
                      params.delete("ask");
                      params.delete("mode");
                      return params;
                    },
                    { replace: true },
                  );
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
                  ? pluralize(total, "owned result")
                  : borrowedTotal > 0 && placeResults.length === 0
                    ? pluralize(borrowedTotal, "borrowed record")
                    : pluralize(placeResults.length, "matching place")}
                {borrowedTotal > 0 && results.length > 0
                  ? ` · ${pluralize(borrowedTotal, "borrowed record")} shown separately`
                  : ""}{" "}
                for “{qParam}” in {scopeLabel}
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
            {borrowedFromItems.length > 0 && (
              <section className="mt-8" aria-label="Borrowed from other owners">
                <div className="mb-3 flex items-center gap-2">
                  <HandCoins className="size-4 text-brass" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    Borrowed from other owners
                  </h2>
                  <Badge variant="brass">Not owned stock</Badge>
                </div>
                <div className="surface divide-y divide-border/60 overflow-hidden">
                  {borrowedFromItems.map((record) => (
                    <BorrowedSearchResult key={record.id} record={record} />
                  ))}
                </div>
              </section>
            )}
            {borrowedResults.length > borrowedFromItems.length && (
              <section className="mt-8" aria-label="Borrowed quick results">
                <div className="mb-3 flex items-center gap-2">
                  <HandCoins className="size-4 text-brass" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    More borrowed matches
                  </h2>
                </div>
                <div className="surface divide-y divide-border/60 overflow-hidden">
                  {borrowedResults.map((result) => (
                    <BorrowedQuickResult key={result.id} result={result} />
                  ))}
                </div>
              </section>
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
  scopeLabel,
  onAskAgain,
  onKeyword,
}: {
  answer: NaturalSearchResponse;
  scopeLabel: string;
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
  const answerBorrowed = answer.borrowed ?? [];
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

      {answerBorrowed.length > 0 && (
        <section aria-label="Borrowed records">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
              {pluralize(answer.borrowed_total ?? answerBorrowed.length, "borrowed record")}
            </h2>
            <Badge variant="brass">Borrowed · not owned stock</Badge>
          </div>
          <div className="surface divide-y divide-border/60 overflow-hidden">
            {answerBorrowed.map((record) => (
              <BorrowedSearchResult key={record.id} record={record} />
            ))}
          </div>
        </section>
      )}
      {answerItems.length > 0 ? (
        <section aria-label="Matching items">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
              {pluralize(answer.total, "owned matching item")}
            </h2>
            <p className="text-[0.7rem] text-muted-foreground">
              {answer.scope_label ?? scopeLabel}
            </p>
          </div>
          <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
            {answerItems.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ) : answerBorrowed.length === 0 ? (
        <div className="surface px-5 py-4 text-[0.78rem] leading-relaxed text-muted-foreground">
          No matching owned item records were returned. The answer above is based on the
          recorded filters and loan state, not on a model's memory.
        </div>
      ) : (
        <p className="text-[0.74rem] text-muted-foreground">
          No owned item records matched; the borrowed records above are held from other
          owners and are not household stock.
        </p>
      )}
    </div>
  );
}

function contextualFilterLink(answer: NaturalSearchResponse): string | null {
  if ((answer.households?.length ?? 0) > 1 || answer.property) return null;
  let path: string | null = null;
  if (answer.tool === "find_missing_information") {
    const criterion = String(answer.facts.criterion ?? "");
    if (criterion === "missing_purchase") path = "/items?purchase_info=missing";
    else if (criterion === "missing_purchase_date") {
      path = "/items?purchase_info=missing_date";
    } else if (criterion === "missing_purchase_price") {
      path = "/items?purchase_info=missing_price";
    } else if (criterion === "purchase_unknown") {
      path = "/items?purchase_info=unknown";
    } else if (criterion === "purchase_not_applicable") {
      path = "/items?purchase_info=not_applicable";
    } else {
      path = "/items";
    }
  } else if (answer.tool === "list_outstanding_loans") {
    path = "/loans";
  } else if (answer.tool === "locate_item" && answer.facts.whereabouts) {
    const whereabouts = answer.facts.whereabouts as { item_id?: string };
    if (whereabouts.item_id) path = `/items/${whereabouts.item_id}`;
  } else if (answer.tool === "get_warranty_status") {
    path = "/warranties";
  } else if (answer.tool === "search_documents") {
    path = "/documents";
  } else if (answer.tool === "get_purchase_history") {
    path = "/purchases";
  }
  if (!path) return null;
  return withHousehold(path, answer.households?.[0]?.id);
}

function BorrowedSearchResult({ record }: { record: BorrowedRecord }) {
  const place =
    [record.property_name, record.room_name, record.storage_location_name]
      .filter(Boolean)
      .join(" / ") || "keeping place not recorded";
  return (
    <Link
      to={`/borrowed/${record.id}`}
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/30"
    >
      <HandCoins className="mt-0.5 size-4 shrink-0 text-brass" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[0.84rem] font-medium">{record.item_name}</span>
          <Badge variant="brass">Borrowed</Badge>
          {record.due_on && (
            <span className="text-[0.65rem] text-muted-foreground">
              due {formatDate(record.due_on)}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[0.7rem] text-muted-foreground">
          belongs to {record.owner_name} · kept at {place} ·{" "}
          {record.outstanding_quantity} outstanding
        </span>
      </span>
    </Link>
  );
}

function BorrowedQuickResult({ result }: { result: QuickSearchResult }) {
  return (
    <Link
      to={withHousehold(result.url, result.household?.id)}
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/30"
    >
      <HandCoins className="mt-0.5 size-4 shrink-0 text-brass" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[0.84rem] font-medium">{result.title}</span>
          <Badge variant="brass">Borrowed</Badge>
        </span>
        <span className="mt-0.5 block text-[0.7rem] text-muted-foreground">
          {[result.household?.name, result.subtitle, result.context]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </Link>
  );
}

function PlaceResult({ result }: { result: QuickSearchResult }) {
  const Icon = result.kind === "container" ? Boxes : MapPin;
  const label = result.kind === "container" ? "Container" : "Location";
  return (
    <Link
      to={withHousehold(result.url, result.household?.id)}
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
          {[result.household?.name, result.subtitle, result.context]
            .filter(Boolean)
            .join(" · ") || "Housetory"}
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
