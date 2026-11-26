import {
  AlertCircle,
  ArrowRight,
  Boxes,
  Bot,
  HandCoins,
  Loader2,
  MapPin,
  Mic,
  Package,
  Paperclip,
  Search,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDuration, useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { api, getApiErrorMessage } from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRememberedSearchScope } from "@/hooks/use-search-scope";
import { withHousehold } from "@/lib/household-links";
import {
  queryKeys,
  useAiStatus,
  useQuickSearch,
  useVoiceConfig,
  useVoiceNote,
} from "@/lib/queries";
import type { QuickSearchKind, QuickSearchResult, VoiceNote } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { DOCUMENT_FILE_ACCEPT, documentFileError } from "@/lib/document-files";
import {
  useOptionalAssistantPageContext,
  type AssistantPageReference,
} from "@/lib/assistant-page-context";

const CONTEXT_LABELS: Record<AssistantPageReference["kind"], string> = {
  item: "This item",
  document: "This document",
  room: "This room",
  location: "This place",
};

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

function hasConfidentQuickMatch(query: string, results: QuickSearchResult[]) {
  const queryTokens = query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (queryTokens.length === 0) return false;
  const queryPhrase = ` ${queryTokens.join(" ")} `;
  return results.some((result) => {
    const resultPhrase = ` ${
      `${result.title} ${result.subtitle ?? ""}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.join(" ") ?? ""
    } `;
    return resultPhrase.includes(queryPhrase);
  });
}

export function QuickSearch({
  variant = "top",
  className,
  onAsk,
  onAttach,
  onOpenAssistant,
  reviewCount = 0,
  placement = "top",
  compact = false,
  onFocusChange,
}: {
  variant?: "top" | "mobile";
  className?: string;
  onAsk: (query: string, trigger: HTMLElement) => void;
  onAttach?: (file: File, trigger: HTMLElement, query: string) => void;
  onOpenAssistant: (trigger: HTMLElement) => void;
  reviewCount?: number;
  /** "bottom" when the field sits at the bottom of the screen: notices go above it. */
  placement?: "top" | "bottom";
  /** Little room: hide attach and voice while there is text. */
  compact?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const attachInputRef = React.useRef<HTMLInputElement>(null);
  const attachButtonRef = React.useRef<HTMLButtonElement>(null);
  const assistantButtonRef = React.useRef<HTMLButtonElement>(null);
  const voiceButtonRef = React.useRef<HTMLButtonElement>(null);
  const pendingEditRef = React.useRef<string | null>(null);
  const pendingEditPathRef = React.useRef(location.pathname);
  const synchronizedPathRef = React.useRef(location.pathname);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const voiceNoticeId = React.useId();
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState(() =>
    ["/search", "/items"].includes(location.pathname) ? (searchParams.get("q") ?? "") : "",
  );
  const [focused, setFocused] = React.useState(false);
  const [inputFocused, setInputFocused] = React.useState(false);
  const pageContext = useOptionalAssistantPageContext();
  const contextReferences = pageContext?.references ?? [];
  const firstReference = contextReferences[0];
  const context = firstReference
    ? contextReferences.length === 1
      ? { label: CONTEXT_LABELS[firstReference.kind], name: firstReference.name }
      : { label: `${contextReferences.length} selected`, name: `${contextReferences.length} selected items` }
    : null;
  const hideExtras = compact && query.length > 0;
  // With the context chip on a phone there is no room for voice until the field has focus.
  const hideVoice = hideExtras || (compact && context !== null && !inputFocused);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [panelStyle, setPanelStyle] = React.useState<React.CSSProperties>({});
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  const [voiceAvailabilityRequested, setVoiceAvailabilityRequested] = React.useState(false);
  const [pendingRecording, setPendingRecording] = React.useState(false);
  const [voiceNotice, setVoiceNotice] = React.useState<{
    kind: "checking" | "ready" | "cancelled" | "unavailable" | "error" | "processing";
    message: string;
  } | null>(null);
  const transcriptionStatus = useAiStatus("transcription", {
    enabled: voiceAvailabilityRequested,
  });
  const voiceConfig = useVoiceConfig({ enabled: voiceAvailabilityRequested });
  const voiceNoteQuery = useVoiceNote(voiceNoteId ?? undefined);
  const voiceUpload = useMutation({
    mutationFn: ({ file, duration }: { file: File; duration: number }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("duration_seconds", String(duration));
      return api.postForm<VoiceNote>("/voice", form);
    },
    onSuccess: (note) => {
      queryClient.setQueryData(queryKeys.voiceNote(note.id), note);
      setVoiceNoteId(note.id);
      setVoiceNotice({ kind: "processing", message: "Transcribing your recording…" });
    },
    onError: (error) => {
      setVoiceNotice({
        kind: "error",
        message: `The recording could not be transcribed: ${getApiErrorMessage(error)}`,
      });
    },
  });
  const recorder = useVoiceRecorder({
    maxSeconds: voiceConfig.data?.max_duration_seconds ?? 120,
    onRecorded: (file, duration) => {
      setVoiceNotice({ kind: "processing", message: "Uploading and transcribing your recording…" });
      voiceUpload.mutate({ file, duration });
    },
  });
  const voiceNote = voiceNoteQuery.data;
  const voiceProcessing = voiceUpload.isPending || Boolean(voiceNoteId);
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
    if (!voiceNoteId || voiceNote?.id !== voiceNoteId) return;
    if (voiceNote.status === "transcribed") {
      if (!voiceNote.transcript?.trim()) {
        setVoiceNotice({
          kind: "error",
          message: voiceNote.transcript_error || "No words were recognized. Try recording again.",
        });
      } else {
        const transcript = voiceNote.transcript.trim();
        const next = query.trim() ? `${query.trimEnd()} ${transcript}` : transcript;
        pendingEditRef.current = next;
        pendingEditPathRef.current = window.location.pathname;
        setQuery(next);
        setFocused(true);
        setVoiceNotice({
          kind: "ready",
          message: "Transcript ready. Review or edit it, then press Enter to search or ask.",
        });
      }
      setVoiceNoteId(null);
    } else if (voiceNote.status === "failed" || voiceNote.status === "cancelled") {
      setVoiceNotice({
        kind: "error",
        message: voiceNote.transcript_error || "The recording could not be transcribed. Try again.",
      });
      setVoiceNoteId(null);
    }
  }, [query, voiceNote, voiceNoteId]);

  React.useEffect(() => {
    if (voiceNotice?.kind === "ready" && !voiceProcessing) {
      inputRef.current?.focus();
    }
  }, [voiceNotice?.kind, voiceProcessing]);

  React.useEffect(() => {
    if (!voiceNoteId || !voiceNoteQuery.isError) return;
    setVoiceNotice({
      kind: "error",
      message: `The transcript could not be loaded: ${getApiErrorMessage(voiceNoteQuery.error)}`,
    });
    setVoiceNoteId(null);
  }, [voiceNoteId, voiceNoteQuery.error, voiceNoteQuery.isError]);

  React.useEffect(() => {
    if (!pendingRecording || transcriptionStatus.isPending || voiceConfig.isPending) return;
    setPendingRecording(false);
    if (
      transcriptionStatus.isError ||
      !transcriptionStatus.data?.configured ||
      !transcriptionStatus.data.available
    ) {
      const details = transcriptionStatus.isError
        ? getApiErrorMessage(transcriptionStatus.error)
        : transcriptionStatus.data?.error;
      setVoiceNotice({
        kind: "unavailable",
        message: details
          ? `Voice transcription is unavailable: ${details}`
          : transcriptionStatus.data?.configured
            ? "Voice transcription is currently unavailable. Check AI settings and try again."
            : "Voice transcription is not configured. Set it up in AI settings.",
      });
      return;
    }
    setVoiceNotice(null);
    void recorder.start();
  }, [
    pendingRecording,
    recorder.start,
    transcriptionStatus.data,
    transcriptionStatus.error,
    transcriptionStatus.isError,
    transcriptionStatus.isPending,
    voiceConfig.isPending,
  ]);

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedTerm, results.length]);

  React.useEffect(() => {
    if (pendingEditRef.current !== null && pendingEditPathRef.current === location.pathname) return;
    setFocused(false);
  }, [location.pathname]);

  const urlQuery = ["/search", "/items"].includes(location.pathname)
    ? (searchParams.get("q") ?? "")
    : null;
  React.useLayoutEffect(() => {
    const navigated = synchronizedPathRef.current !== location.pathname;
    synchronizedPathRef.current = location.pathname;
    // Preserve edits made on the incoming page before React commits its navigation.
    if (navigated && pendingEditRef.current !== null && pendingEditPathRef.current === location.pathname) return;
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
      { pathname: "/items", search: next.size > 0 ? `?${next.toString()}` : "", hash: location.hash },
      { replace: true },
    );
  }, [debounced, isItemsPage, location.hash, navigate, query, searchParams]);

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
  }, [showPanel, term, voiceNotice, recorder.recording, voiceProcessing]);

  const startRecording = () => {
    if (voiceProcessing || pendingRecording) return;
    setFocused(false);
    setVoiceAvailabilityRequested(true);
    setPendingRecording(true);
    setVoiceNotice({
      kind: "checking",
      message: "Checking voice transcription availability…",
    });
  };

  const cancelRecording = () => {
    recorder.cancel();
    setVoiceNotice({ kind: "cancelled", message: "Recording cancelled. Nothing was sent." });
    window.requestAnimationFrame(() => voiceButtonRef.current?.focus());
  };

  const submitToResults = (explicitAsk: boolean) => {
    if (!term) return;
    setFocused(false);
    if (explicitAsk) {
      askAssistant();
      return;
    }
    if (isItemsPage) {
      const next = new URLSearchParams(searchParams);
      next.set("q", term);
      navigate(`/items?${next.toString()}`, { replace: true });
      return;
    }
    navigate(`/items?q=${encodeURIComponent(term)}`);
  };

  const askAssistant = () => {
    setFocused(false);
    pendingEditRef.current = null;
    if (inputRef.current) onAsk(term, inputRef.current);
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
      if (recorder.recording || voiceProcessing || pendingRecording) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (showAskRow && activeIndex === askIndex && !event.shiftKey) {
        askAssistant();
        return;
      }
      const active = flatResults[activeIndex];
      if (active && !event.shiftKey) choose(active);
      else if (
        term.length >= 2 &&
        (event.shiftKey ||
          !(
            search.data?.query === debouncedTerm &&
            !search.data.question_like &&
            hasConfidentQuickMatch(term, results)
          ))
      ) {
        askAssistant();
      } else submitToResults(event.shiftKey);
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
                  Press Enter to ask Housetory. Straightforward item searches
                  stay local and open a match directly.
                </p>
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
    <div
      ref={wrapperRef}
      className={cn("relative flex gap-2", placement === "bottom" ? "flex-col-reverse" : "flex-col", className)}
    >
      <div
        className={cn(
          "flex h-12 min-w-0 items-center border bg-card/75 text-foreground shadow-[inset_0_1px_0_hsl(var(--card)/0.6)] transition-[border-color,box-shadow,background-color] focus-within:border-ring/50 focus-within:bg-card focus-within:ring-4 focus-within:ring-ring/10",
          variant === "top" ? "rounded-2xl border-input/90" : "rounded-xl border-border/80 bg-card/80 shadow-soft",
        )}
      >
        <button
          ref={assistantButtonRef}
          type="button"
          aria-label={`Open assistant${reviewCount > 0 ? `, ${reviewCount} unresolved reviews` : ""}`}
          title="Open assistant"
          className="relative ml-0.5 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => {
            setFocused(false);
            if (assistantButtonRef.current) onOpenAssistant(assistantButtonRef.current);
          }}
        >
          <Bot className="size-[1.15rem]" />
          {reviewCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-0.5 top-0.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-brass px-1 text-[9px] font-semibold leading-none text-brass-foreground"
            >
              {reviewCount > 99 ? "99+" : reviewCount}
            </span>
          )}
        </button>
        {context && (
          <span
            data-testid="quick-search-context"
            title={context.name}
            className="flex h-8 shrink-0 items-center rounded-full bg-accent pl-2.5 text-xs font-medium text-accent-foreground"
          >
            <span className="max-w-[6.5rem] truncate">{context.label}</span>
            <button
              type="button"
              aria-label={`Remove ${context.label.toLowerCase()} from the question: ${context.name}`}
              title="Ask about everything instead"
              // The visible cross is small; the padding around it makes the target 44 px.
              className="relative flex size-8 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-1.5 before:content-[''] hover:bg-background/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                pageContext?.setReferences([]);
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </span>
        )}
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
          placeholder={context ? "Ask…" : "Search or ask…"}
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
          onFocus={() => {
            setFocused(true);
            setInputFocused(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setInputFocused(false);
            onFocusChange?.(false);
          }}
          onChange={(event) => {
            pendingEditRef.current = event.target.value;
            pendingEditPathRef.current = window.location.pathname;
            setQuery(event.target.value);
            setVoiceNotice(null);
            setFocused(true);
            setActiveIndex(-1);
          }}
          onKeyDown={onKeyDown}
          disabled={recorder.recording || voiceProcessing || pendingRecording}
          aria-describedby={voiceNotice ? voiceNoticeId : undefined}
          className="quick-search-input h-full min-w-0 flex-1 bg-transparent px-1.5 text-[1rem] text-foreground outline-none placeholder:text-muted-foreground lg:text-[0.95rem]"
        />
        {onAttach && (
          <>
            <input
              ref={attachInputRef}
              type="file"
              accept={DOCUMENT_FILE_ACCEPT}
              data-testid="quick-search-attachment-input"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const error = documentFileError(file);
                if (error) {
                  setAttachmentError(error);
                  setFocused(true);
                  return;
                }
                setAttachmentError(null);
                setFocused(false);
                if (attachButtonRef.current) onAttach(file, attachButtonRef.current, query);
              }}
            />
            <button
              ref={attachButtonRef}
              type="button"
              aria-label="Attach a file"
              title="Attach a PDF or image"
              disabled={recorder.recording || voiceProcessing || pendingRecording}
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-45",
                hideExtras && "hidden",
              )}
              onClick={() => attachInputRef.current?.click()}
            >
              <Paperclip className="size-[1.05rem]" />
            </button>
          </>
        )}
        {!inputFocused && !query && (
          <kbd className="pointer-events-none hidden shrink-0 rounded-md border border-border bg-secondary/70 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground lg:block">
            ⌘K
          </kbd>
        )}
        <button
          ref={voiceButtonRef}
          type="button"
          aria-label={recorder.recording ? "Stop recording" : "Record voice search"}
          title={
            pendingRecording
              ? "Checking voice transcription availability"
              : recorder.recording
                ? "Stop recording"
                : "Record a voice search"
          }
          aria-pressed={recorder.recording}
          aria-busy={pendingRecording}
          aria-describedby={voiceNotice ? voiceNoticeId : undefined}
          disabled={voiceProcessing}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-45",
            recorder.recording && "animate-pulse bg-primary text-primary-foreground hover:bg-primary",
            hideVoice && !recorder.recording && "hidden",
          )}
          onClick={recorder.recording ? recorder.stop : startRecording}
        >
          {recorder.recording ? <Square className="size-4" /> : <Mic className="size-[1.05rem]" />}
        </button>
        {query ? (
          <button
            type="button"
            disabled={recorder.recording || voiceProcessing || pendingRecording}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              pendingEditRef.current = "";
              pendingEditPathRef.current = window.location.pathname;
              setQuery("");
              setVoiceNotice(null);
              setActiveIndex(-1);
              inputRef.current?.focus();
            }}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-45"
            aria-label="Clear search"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {recorder.recording && (
        <div
          role="group"
          aria-label="Recording voice search"
          className="flex min-h-11 items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-1.5"
        >
          <span className="size-2.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs tabular-nums">
            Recording {formatDuration(recorder.elapsed)} / {formatDuration(voiceConfig.data?.max_duration_seconds ?? 120)}
          </p>
          <button
            type="button"
            aria-label="Cancel recording"
            className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={cancelRecording}
          >
            <X className="size-3.5" />
            Cancel
          </button>
        </div>
      )}
      {!recorder.recording && voiceProcessing && (
        <p
          role="status"
          aria-live="polite"
          className="flex min-h-10 items-center gap-2 px-2 text-xs text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" />
          Transcribing your recording…
        </p>
      )}
      {!recorder.recording && recorder.error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {recorder.error}
        </p>
      )}
      {!recorder.recording && voiceNotice && !voiceProcessing && (
        <p
          id={voiceNoticeId}
          role={["unavailable", "error"].includes(voiceNotice.kind) ? "alert" : "status"}
          aria-live={["unavailable", "error"].includes(voiceNotice.kind) ? "assertive" : "polite"}
          className={cn(
            "px-2 text-xs",
            ["unavailable", "error"].includes(voiceNotice.kind)
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {voiceNotice.message}
          {["unavailable", "error"].includes(voiceNotice.kind) && (
            <>
              {" "}
              <Link to="/settings/ai" className="underline underline-offset-4">
                AI settings
              </Link>
            </>
          )}
        </p>
      )}
      {attachmentError && (
        <p role="alert" className="px-2 text-2xs text-destructive">
          {attachmentError}
        </p>
      )}
      {panel}
    </div>
  );
}
