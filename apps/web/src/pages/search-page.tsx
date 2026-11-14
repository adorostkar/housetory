import {
  AlertCircle,
  Boxes,
  HandCoins,
  Loader2,
  MapPin,
  RotateCcw,
  Search as SearchIcon,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AnswerText } from "@/components/answer-text";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { SearchScopeSelect } from "@/components/search-scope-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSearchScope } from "@/hooks/use-search-scope";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  borrowedLocationPrefix,
  borrowedPlaceLabel,
} from "@/lib/borrowed";
import { withHousehold } from "@/lib/household-links";
import { useSearchSession } from "@/lib/search-session";
import type {
  BorrowedRecord,
  QuickSearchResult,
  SearchQueryResponse,
} from "@/lib/types";
import { formatDate, pluralize } from "@/lib/utils";

const EXAMPLES = [
  "Where is my heavy drill?",
  "What is on loan?",
  "Which items have no purchase information?",
];

const MODE_INFO = {
  direct: {
    label: "Direct inventory lookup",
    icon: SearchIcon,
    variant: "sage" as const,
    description: "Matched recorded inventory, places and loans directly.",
  },
  ai: {
    label: "AI-assisted answer",
    icon: Sparkles,
    variant: "brass" as const,
    description:
      "Interpreted with the configured assistant and grounded in read-only inventory facts.",
  },
  fallback: {
    label: "AI unavailable · direct results only",
    icon: AlertCircle,
    variant: "outline" as const,
    description:
      "No configured assistant could complete the interpretation. Direct records are still shown.",
  },
};

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { selection, label: scopeLabel } = useSearchScope(true);
  const session = useSearchSession();
  const q = (searchParams.get("q") ?? "").trim();
  const explicitAsk = searchParams.get("ask") === "1";
  const runId = searchParams.get("r") ?? "";
  const [response, setResponse] = React.useState<SearchQueryResponse | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const requestKey = React.useRef("");
  const sessionSnapshot = React.useRef(session);
  sessionSnapshot.current = session;

  React.useEffect(() => {
    if (!q) {
      requestKey.current = "";
      setResponse(null);
      setPending(false);
      setError(null);
      return;
    }
    const key = [
      q,
      explicitAsk ? "ask" : "search",
      runId,
      selection.householdId,
      selection.propertyId,
    ].join("|");
    if (requestKey.current === key) return;
    requestKey.current = key;
    const controller = new AbortController();
    const snapshot = sessionSnapshot.current;
    setPending(true);
    setError(null);
    api
      .post<SearchQueryResponse>(
        "/search/query",
        {
          query: q,
          explicit_ask: explicitAsk,
          history: snapshot.turns,
          ...(snapshot.context ? { context: snapshot.context } : {}),
          ...(selection.householdId
            ? { household_id: selection.householdId }
            : {}),
          ...(selection.propertyId
            ? { property_id: selection.propertyId }
            : {}),
          limit: 40,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setResponse(result);
        snapshot.record(q, result);
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setError(requestError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
    // Session history/context are snapshotted; recording a result must not
    // trigger another paid request in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, explicitAsk, runId, selection.householdId, selection.propertyId]);

  const reset = () => {
    session.reset();
    requestKey.current = "";
    setResponse(null);
    setError(null);
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.delete("q");
        params.delete("ask");
        params.delete("r");
        return params;
      },
      { replace: true },
    );
    window.setTimeout(() => {
      document
        .querySelector<HTMLInputElement>('[data-quick-search-input="true"]')
        ?.focus();
    }, 0);
  };

  const runExample = (example: string) => {
    session.reset();
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set("q", example);
        params.set("r", Date.now().toString());
        params.delete("ask");
        return params;
      },
      { replace: true },
    );
  };

  const retry = () => {
    requestKey.current = "";
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set("r", Date.now().toString());
        return params;
      },
      { replace: true },
    );
  };

  const mode = response ? MODE_INFO[response.mode] : null;
  const nonItemQuick =
    response?.quick_results.filter((result) => result.kind !== "item") ?? [];
  const filterLink = response ? contextualFilterLink(response) : null;

  return (
    <div className="animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Search</p>
          <h1 className="mt-1 truncate font-display text-[1.75rem] tracking-[-0.02em] sm:text-[2.1rem]">
            {q ? (
              <>
                Results for “<bdi dir="auto">{q}</bdi>”
              </>
            ) : (
              "Find anything"
            )}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {q
              ? `Searched ${scopeLabel} · current records re-read on submit`
              : "One search across items, places, loans and questions."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchScopeSelect compact />
          <Button type="button" size="sm" variant="outline" onClick={reset}>
            <RotateCcw />
            New search
          </Button>
        </div>
      </div>

      <div className="mt-6">
        {!q ? (
          <section className="surface px-5 py-8 sm:px-7">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <SearchIcon className="size-4" strokeWidth={1.7} />
              </span>
              <div className="min-w-0">
                <h2 className="font-display text-[1.3rem] tracking-[-0.02em]">
                  Search or ask in one box
                </h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  Type a name, model, serial number, room or container. Press Enter
                  to search; if the wording needs interpretation, the configured
                  assistant is used automatically. Follow-up questions keep the
                  resolved item and current scope.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => runExample(example)}
                      className="rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : pending ? (
          <SearchPending />
        ) : error ? (
          <ErrorState
            title="Search could not be completed"
            message={getApiErrorMessage(error)}
            onRetry={retry}
          />
        ) : response ? (
          <div className="space-y-6">
            <section className="surface p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                {mode && (
                  <Badge variant={mode.variant}>
                    <mode.icon className="size-3" />
                    {mode.label}
                  </Badge>
                )}
                <span className="text-2xs text-muted-foreground">
                  {mode?.description}
                </span>
              </div>
              {response.answer && (
                <AnswerText
                  text={response.answer}
                  direction={response.answer_direction ?? "auto"}
                  preserveTerms={response.preserve_terms ?? []}
                  className="mt-3 text-[0.92rem] leading-[1.8]"
                />
              )}
              {response.needs_clarification && response.items.length > 1 && (
                <p className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  Several concrete records match. Choose the item below, or ask a
                  short follow-up naming the one you meant.
                </p>
              )}
              {response.notices.length > 0 && (
                <ul className="mt-3 space-y-1 text-2xs leading-relaxed text-muted-foreground">
                  {response.notices.map((notice) => (
                    <li key={notice}>• {notice}</li>
                  ))}
                </ul>
              )}
              {filterLink && (
                <Button className="mt-3" size="sm" variant="outline" asChild>
                  <Link to={filterLink}>
                    {response.tool === "locate_item"
                      ? "Open item"
                      : response.tool === "find_missing_information"
                        ? "Open matching filters"
                        : "Open matching records"}
                  </Link>
                </Button>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <span className="text-2xs text-muted-foreground">
                  {response.mode === "direct"
                    ? "No model call was needed for this result."
                    : response.mode === "ai"
                      ? "Answer generated from authorised read-only records."
                      : "Ordinary direct search still works without AI."}
                </span>
                {response.interpretation &&
                  response.mode !== "direct" && (
                    <details className="ml-auto">
                      <summary className="cursor-pointer text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                        How this was matched
                      </summary>
                      <p className="mt-1 max-w-xl text-2xs leading-relaxed text-muted-foreground">
                        {response.interpretation}
                      </p>
                    </details>
                  )}
              </div>
            </section>

            {response.items.length > 0 ? (
              <section aria-label="Matching items">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    {pluralize(
                      response.total || response.items.length,
                      "matching item",
                    )}
                  </h2>
                  <p className="text-2xs text-muted-foreground">
                    {response.scope_label ?? scopeLabel}
                  </p>
                </div>
                <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
                  {response.items.map((item) => (
                    <ItemCard key={item.id} item={item} />
                  ))}
                </div>
                {response.total > response.items.length && (
                  <p className="mt-3 text-2xs text-muted-foreground">
                    Showing the first {response.items.length} of {response.total}{" "}
                    matching records.
                  </p>
                )}
              </section>
            ) : response.borrowed.length === 0 && nonItemQuick.length === 0 ? (
              <section className="surface px-5 py-6 text-center">
                <p className="text-sm font-medium">
                  {response.mode === "fallback"
                    ? "No direct record matched"
                    : "No matching inventory records"}
                </p>
                <p className="mx-auto mt-1 max-w-lg text-2xs leading-relaxed text-muted-foreground">
                  {response.mode === "fallback"
                    ? "The question could not be interpreted without a configured assistant, so this is not presented as a conclusive no-result answer. Try the item's recorded name or configure AI for this household."
                    : "Try a shorter name, a model or serial number, a room or container, or ask a follow-up."}
                </p>
                <Button className="mt-4" variant="outline" onClick={reset}>
                  <RotateCcw />
                  New search
                </Button>
              </section>
            ) : null}

            {response.borrowed.length > 0 && (
              <section aria-label="Borrowed records">
                <div className="mb-3 flex items-center gap-2">
                  <HandCoins className="size-4 text-brass" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    Borrowed from other owners
                  </h2>
                  <Badge variant="brass">Not owned stock</Badge>
                </div>
                <div className="surface divide-y divide-border/60 overflow-hidden">
                  {response.borrowed.map((record) => (
                    <BorrowedResult key={record.id} record={record} />
                  ))}
                </div>
              </section>
            )}

            {nonItemQuick.length > 0 && (
              <section aria-label="Matching containers and locations">
                <div className="mb-3 flex items-center gap-2">
                  <Boxes className="size-4 text-brass" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    Places and containers
                  </h2>
                </div>
                <div className="surface divide-y divide-border/60 overflow-hidden">
                  {nonItemQuick.map((result) => (
                    <PlaceResult key={`${result.kind}-${result.id}`} result={result} />
                  ))}
                </div>
              </section>
            )}

            {response.references.some(
              (reference) =>
                !(
                  reference.type === "item" &&
                  response.items.some((item) => item.id === reference.id)
                ),
            ) && (
              <section aria-label="Sources" className="flex flex-wrap gap-1.5">
                {response.references
                  .filter(
                    (reference) =>
                      !(
                        reference.type === "item" &&
                        response.items.some((item) => item.id === reference.id)
                      ),
                  )
                  .slice(0, 12)
                  .map((reference) => (
                  <Link
                    key={`${reference.type}-${reference.id}`}
                    to={withHousehold(reference.url, reference.household_id)}
                  >
                    <Badge variant="outline" className="hover:bg-secondary">
                      {reference.title}
                    </Badge>
                    </Link>
                  ))}
              </section>
            )}
          </div>
        ) : (
          <SearchPending />
        )}
      </div>
    </div>
  );
}

function contextualFilterLink(response: SearchQueryResponse): string | null {
  if ((response.households?.length ?? 0) > 1 || response.property) return null;
  let path: string | null = null;
  if (response.tool === "find_missing_information") {
    const criterion = String(response.facts.criterion ?? "");
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
  } else if (response.tool === "list_outstanding_loans") {
    path = "/loans";
  } else if (response.tool === "locate_item" && response.facts.whereabouts) {
    const whereabouts = response.facts.whereabouts as { item_id?: string };
    if (whereabouts.item_id) path = `/items/${whereabouts.item_id}`;
  } else if (response.tool === "get_warranty_status") {
    path = "/warranties";
  } else if (response.tool === "search_documents") {
    path = "/documents";
  } else if (response.tool === "get_purchase_history") {
    path = "/purchases";
  }
  if (!path) return null;
  return withHousehold(path, response.households?.[0]?.id);
}

function BorrowedResult({ record }: { record: BorrowedRecord }) {
  const place = borrowedPlaceLabel(record);
  return (
    <Link
      to={withHousehold(`/borrowed/${record.id}`, record.household_id)}
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/30"
    >
      <HandCoins className="mt-0.5 size-4 shrink-0 text-brass" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {record.item_name}
          </span>
          <Badge variant="brass">Borrowed</Badge>
          {record.due_on && (
            <span className="text-2xs text-muted-foreground">
              due {formatDate(record.due_on)}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-2xs text-muted-foreground">
          belongs to {record.owner_name} ·{" "}
          {borrowedLocationPrefix(record)} {place} ·{" "}
          {record.outstanding_quantity} outstanding
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
          <span className="truncate text-sm font-medium">
            {result.title}
          </span>
          <Badge
            variant={result.kind === "container" ? "brass" : "outline"}
            className="text-2xs"
          >
            {label}
          </Badge>
        </span>
        <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
          {[result.household?.name, result.subtitle, result.context]
            .filter(Boolean)
            .join(" · ") || "Housetory"}
        </span>
      </span>
    </Link>
  );
}

function SearchPending() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="surface flex items-center gap-3 p-5 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Searching current records and interpreting when needed…
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-2xl border border-border/70"
          >
            <Skeleton className="aspect-[4/3] rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
