import {
  AlertCircle,
  ArrowRight,
  Boxes,
  HandCoins,
  Loader2,
  MapPin,
  Package,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRememberedSearchScope } from "@/hooks/use-search-scope";
import { withHousehold } from "@/lib/household-links";
import { useQuickSearch } from "@/lib/queries";
import type { QuickSearchKind, QuickSearchResult } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

const GROUPS: Array<{
  kind: QuickSearchKind;
  label: string;
  icon: typeof Package;
  tone: "sage" | "brass" | "outline";
}> = [
  { kind: "item", label: "Owned items", icon: Package, tone: "sage" },
  { kind: "borrowed", label: "Borrowed from others", icon: HandCoins, tone: "brass" },
  { kind: "container", label: "Boxes & containers", icon: Boxes, tone: "brass" },
  { kind: "location", label: "Locations", icon: MapPin, tone: "outline" },
];

function resultLabel(kind: QuickSearchKind) {
  if (kind === "container") return "Container";
  if (kind === "location") return "Location";
  if (kind === "borrowed") return "Borrowed";
  return "Owned item";
}

function contextLine(result: QuickSearchResult) {
  const base = [result.household?.name, result.subtitle, result.context]
    .filter(Boolean)
    .join(" · ");
  if (!result.loan) return base;
  const borrower = result.loan.borrower_names.length
    ? result.loan.borrower_names.slice(0, 2).join(", ")
    : "unnamed borrower";
  const due = result.loan.next_due_on
    ? ` · due ${formatDate(result.loan.next_due_on)}`
    : "";
  const quantity = result.loan.on_loan_quantity;
  const loan = `On loan to ${borrower} · ${quantity} ${quantity === 1 ? "unit" : "units"}${due}`;
  return [loan, base].filter(Boolean).join(" · ");
}

export function QuickSearch({
  variant = "top",
  className,
}: {
  variant?: "top" | "mobile";
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pendingEditRef = React.useRef<string | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState(() =>
    ["/search", "/items"].includes(location.pathname) ? (searchParams.get("q") ?? "") : "",
  );
  const [focused, setFocused] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [panelStyle, setPanelStyle] = React.useState<React.CSSProperties>({});
  const isItemsPage = location.pathname === "/items";
  const debounced = useDebouncedValue(query, 220);
  const term = query.trim();
  const debouncedTerm = debounced.trim();
  const waiting = term.length >= 2 && term !== debouncedTerm;
  const searchScope = useRememberedSearchScope();
  const search = useQuickSearch(
    debouncedTerm,
    4,
    focused,
    searchScope.selection,
  );
  const showPanel = focused && term.length > 0;
  const results =
    !waiting && search.data?.query === debouncedTerm ? search.data.results : [];
  const loading =
    term.length >= 2 &&
    (waiting || search.isPending || (search.isFetching && results.length === 0));
  const error = !waiting && search.isError;
  const groups = GROUPS.map((group) => ({
    ...group,
    results: results.filter((result) => result.kind === group.kind),
  })).filter((group) => group.results.length > 0);
  const flatResults = groups.flatMap((group) => group.results);
  const showAskRow = term.length >= 2 && !loading && !error;
  const askIndex = flatResults.length;
  const optionCount = flatResults.length + (showAskRow ? 1 : 0);

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedTerm, results.length]);

  React.useEffect(() => {
    setFocused(false);
  }, [location.pathname]);

  const urlQuery = ["/search", "/items"].includes(location.pathname)
    ? (searchParams.get("q") ?? "")
    : null;
  React.useEffect(() => {
    pendingEditRef.current = null;
    if (urlQuery === null) return;
    setQuery((current) => (current === urlQuery ? current : urlQuery));
  }, [urlQuery, location.pathname]);

  React.useEffect(() => {
    // Responsive peers consume URL changes; only user edits may publish them.
    if (!isItemsPage || query !== debounced || pendingEditRef.current !== query) return;
    pendingEditRef.current = null;
    const trimmed = debounced.trim();
    const current = searchParams.get("q") ?? "";
    if (trimmed === current) return;
    const next = new URLSearchParams(searchParams);
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    navigate(
      { pathname: "/items", search: next.size > 0 ? `?${next.toString()}` : "" },
      { replace: true },
    );
  }, [debounced, isItemsPage, navigate, query, searchParams]);

  React.useEffect(() => {
    if (!focused) setActiveIndex(-1);
  }, [focused]);

  React.useEffect(() => {
    if (!showPanel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !wrapperRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setFocused(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (
        !wrapperRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setFocused(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [showPanel]);

  React.useLayoutEffect(() => {
    if (!showPanel) return;
    const updatePosition = () => {
      const anchor = wrapperRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(Math.max(rect.width, 320), viewportWidth - 24);
      const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
      const panelHeight = Math.min(440, viewportHeight - 24);
      const below = viewportHeight - rect.bottom - 12;
      const top =
        below >= 220
          ? rect.bottom + 8
          : Math.max(12, rect.top - Math.min(panelHeight, rect.top - 12) - 8);
      setPanelStyle({
        position: "fixed",
        left,
        top,
        width,
        maxHeight: Math.min(panelHeight, below >= 220 ? below : rect.top - 18),
        zIndex: 80,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [showPanel, term]);

  const submitToResults = (explicitAsk: boolean) => {
    if (!term) return;
    setFocused(false);
    if (isItemsPage && !explicitAsk) {
      const next = new URLSearchParams(searchParams);
      next.set("q", term);
      navigate(`/items?${next.toString()}`, { replace: true });
      return;
    }
    const params = new URLSearchParams({
      q: term,
      r: Date.now().toString(),
    });
    if (explicitAsk) params.set("ask", "1");
    navigate(`/search?${params.toString()}`);
  };

  const askAssistant = () => {
    setFocused(false);
    navigate(`/assistant?q=${encodeURIComponent(term)}`);
  };

  const choose = (result: QuickSearchResult) => {
    setFocused(false);
    navigate(withHousehold(result.url, result.household?.id));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setFocused(false);
      setActiveIndex(-1);
      inputRef.current?.blur();
      return;
    }
    if (!showPanel) return;
    if (event.key === "ArrowDown" && optionCount > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % optionCount);
      return;
    }
    if (event.key === "ArrowUp" && optionCount > 0) {
      event.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? optionCount - 1 : current - 1,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (showAskRow && activeIndex === askIndex && !event.shiftKey) {
        askAssistant();
        return;
      }
      const active = flatResults[activeIndex];
      if (active && !event.shiftKey) choose(active);
      else submitToResults(event.shiftKey);
    }
  };

  const askRow = showAskRow ? (
    <button
      type="button"
      role="option"
      aria-selected={activeIndex === askIndex}
      id={`quick-search-option-${askIndex}`}
      onMouseEnter={() => setActiveIndex(askIndex)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={askAssistant}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition-colors",
        activeIndex === askIndex
          ? "bg-secondary text-foreground"
          : "text-foreground/85 hover:bg-secondary/70",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brass-soft/40 text-brass">
        <Sparkles className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        Ask the assistant: “{term}”
      </span>
    </button>
  ) : null;

  const panel =
    showPanel && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="flex flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/98 shadow-lift backdrop-blur-xl"
            id="quick-search-panel"
          >
            {term.length < 2 ? (
              <p className="px-4 py-3 text-2xs text-muted-foreground" role="status">
                Keep typing to find items, boxes and places — then press Enter.
              </p>
            ) : error ? (
              <div className="flex items-start gap-2.5 px-4 py-4 text-xs" role="alert">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p>Search is unavailable just now.</p>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    {getApiErrorMessage(search.error)}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => void search.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            ) : loading ? (
              <div
                className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" />
                Searching your places…
              </div>
            ) : results.length === 0 ? (
              <div
                className="space-y-3 px-4 py-4 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <p className="flex items-center gap-2">
                  <Search className="size-4" />
                  No quick matches for “{term}”.
                </p>
                <p className="text-2xs leading-relaxed">
                  Press Enter to search all records. Housetory will interpret the
                  question with the configured assistant when needed.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => submitToResults(true)}
                >
                  <Sparkles />
                  Ask Housetory
                </Button>
                <div
                  role="listbox"
                  id="quick-search-results"
                  aria-label="Assistant"
                >
                  {askRow}
                </div>
              </div>
            ) : (
              <>
                <div
                  id="quick-search-results"
                  role="listbox"
                  aria-label="Quick search results"
                  className="min-h-0 flex-1 overflow-y-auto p-1.5"
                >
                  {groups.map((group) => (
                    <section key={group.kind} aria-label={group.label}>
                      <p className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {group.label}
                      </p>
                      {group.results.map((result) => {
                        const index = flatResults.indexOf(result);
                        const Icon = group.icon;
                        return (
                          <button
                            key={`${result.kind}-${result.id}`}
                            type="button"
                            role="option"
                            aria-selected={index === activeIndex}
                            id={`quick-search-option-${index}`}
                            onMouseEnter={() => setActiveIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => choose(result)}
                            className={cn(
                              "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                              index === activeIndex
                                ? "bg-secondary text-foreground"
                                : "text-foreground/85 hover:bg-secondary/70",
                            )}
                          >
                            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-background/70 text-muted-foreground">
                              <Icon className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium">
                                  {result.title}
                                </span>
                                <Badge variant={group.tone} className="shrink-0 text-2xs">
                                  {resultLabel(result.kind)}
                                </Badge>
                              </span>
                              <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                                {contextLine(result) || "Housetory"}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {askRow}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
                  <span className="text-2xs text-muted-foreground">
                    {results.length} quick match{results.length === 1 ? "" : "es"}
                    {search.data?.scope_label ? ` · ${search.data.scope_label}` : ""}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-2xs"
                      onClick={() => submitToResults(true)}
                      title="Ask the configured assistant (Shift+Enter)"
                    >
                      <Sparkles className="size-3" />
                      Ask Housetory
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-2xs"
                      onClick={() => submitToResults(false)}
                    >
                      {isItemsPage ? "Filter items" : "View all results"}
                      <ArrowRight className="size-3" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        type="search"
        data-quick-search-input="true"
        data-quick-search-variant={variant}
        value={query}
        maxLength={2000}
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        placeholder="Search or ask about your inventory…"
        aria-label="Search or ask about your inventory"
        aria-keyshortcuts="Meta+K Control+K"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={
          showPanel && optionCount > 0 ? "quick-search-results" : undefined
        }
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `quick-search-option-${activeIndex}` : undefined
        }
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          pendingEditRef.current = event.target.value;
          setQuery(event.target.value);
          setFocused(true);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "quick-search-input w-full rounded-2xl border border-input/90 bg-card/75 pl-11 pr-16 text-foreground shadow-[inset_0_1px_0_hsl(var(--card)/0.6)] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground focus:border-ring/50 focus:bg-card focus:ring-4 focus:ring-ring/10",
          variant === "top"
            ? "h-12 text-[0.95rem]"
            : "h-12 rounded-xl border-border/80 bg-card/80 text-[1rem] shadow-soft",
        )}
      />
      <kbd className="pointer-events-none absolute right-11 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-secondary/70 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground sm:block">
        ⌘K
      </kbd>
      {query ? (
        <button
          type="button"
          onClick={() => {
            pendingEditRef.current = "";
            setQuery("");
            setActiveIndex(-1);
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-4" />
        </button>
      ) : null}
      {panel}
    </div>
  );
}
