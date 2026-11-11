import { useMutation } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  FileText,
  HandCoins,
  Info,
  Loader2,
  MapPin,
  Mic,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { AddItemsButton } from "@/components/add-items";
import { AnswerText } from "@/components/answer-text";
import { SearchScopeSelect } from "@/components/search-scope-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSearchScope } from "@/hooks/use-search-scope";
import { api, getApiErrorMessage } from "@/lib/api";
import { withHousehold } from "@/lib/household-links";
import { useAiStatus } from "@/lib/queries";
import { followUpSuggestions } from "@/lib/assistant-followups";
import { useSearchSession } from "@/lib/search-session";
import { useSpeechDictation } from "@/lib/use-speech-dictation";
import type { SearchQueryResponse } from "@/lib/types";
import { borrowedLocationPrefix, borrowedPlaceLabel } from "@/lib/borrowed";
import { itemContainer, locationLabel } from "@/lib/utils";

const SUGGESTIONS = [
  "Where is my heavy drill?",
  "Which items have no purchase information?",
  "What is on loan?",
  "What do I need to return?",
  "Who owns the ladder?",
  "What do I have stored in the attic?",
  "Which warranties are expiring soon?",
  "How many suitcases do I own?",
];

interface Message {
  role: "user" | "assistant";
  text: string;
  response?: SearchQueryResponse;
}

export function AssistantPage() {
  const aiStatus = useAiStatus();
  const { selection, scopesQuery } = useSearchScope(true);
  const searchSession = useSearchSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [question, setQuestion] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);
  const autoAskedRef = React.useRef<string | null>(null);
  const scopeSignature = `${selection.householdId}|${selection.propertyId}`;
  const lastScopeRef = React.useRef(scopeSignature);

  React.useEffect(() => {
    if (lastScopeRef.current === scopeSignature) return;
    lastScopeRef.current = scopeSignature;
    setMessages([]);
    setQuestion("");
  }, [scopeSignature]);

  const ask = useMutation({
    mutationFn: ({
      value,
      regenerate,
    }: {
      value: string;
      regenerate?: boolean;
    }) =>
      api.post<SearchQueryResponse>("/search/query", {
        query: value,
        explicit_ask: true,
        // Regenerating must not show the model the answer being replaced.
        history: regenerate
          ? searchSession.turns.slice(0, -2)
          : searchSession.turns,
        ...(searchSession.context ? { context: searchSession.context } : {}),
        ...(selection.householdId
          ? { household_id: selection.householdId }
          : {}),
        ...(selection.propertyId ? { property_id: selection.propertyId } : {}),
        limit: 40,
      }),
    onSuccess: (response, { value, regenerate }) => {
      setMessages((current) => [
        ...(regenerate ? current.slice(0, -2) : current),
        { role: "user", text: value },
        {
          role: "assistant",
          text:
            response.answer ?? "No matching inventory records were returned.",
          response,
        },
      ]);
      // record() collapses a repeated last question into the same turn pair,
      // so regenerating only refreshes the stored context.
      searchSession.record(value, response);
      if (!regenerate) setQuestion("");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  React.useEffect(() => {
    const value = searchParams.get("q")?.trim() ?? "";
    if (scopesQuery.isPending) return;
    if (value.length < 2 || autoAskedRef.current === value) return;
    autoAskedRef.current = value;
    ask.mutate({ value });
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
    // The URL is the handoff trigger; ask.mutate uses the current messages at
    // the moment the handoff occurs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams, scopesQuery.isPending]);

  const paneRef = React.useRef<HTMLDivElement>(null);
  const lastAnswerRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const dictation = useSpeechDictation((text) =>
    setQuestion((current) =>
      current.trim() ? `${current.trimEnd()} ${text}` : text,
    ),
  );
  const [nearBottom, setNearBottom] = React.useState(true);
  const [infoOpen, setInfoOpen] = React.useState(false);

  const updateNearBottom = () => {
    const pane = paneRef.current;
    if (!pane) return;
    setNearBottom(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80);
  };

  const jumpToLatest = () => {
    if (typeof endRef.current?.scrollIntoView === "function") {
      endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  };

  React.useEffect(() => {
    const last = messages[messages.length - 1];
    const target =
      last?.role === "assistant" && !ask.isPending
        ? lastAnswerRef.current
        : endRef.current;
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: "smooth",
        block: target === endRef.current ? "end" : "start",
      });
    }
  }, [messages, ask.isPending]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [question]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = question.trim();
    if (value.length < 2 || ask.isPending) return;
    dictation.stop();
    ask.mutate({ value });
  };

  const newConversation = () => {
    if (ask.isPending) return;
    setMessages([]);
    setQuestion("");
    searchSession.reset();
    autoAskedRef.current = null;
  };

  const askSuggestion = (value: string) => {
    setQuestion("");
    ask.mutate({ value });
  };

  const regenerateLatest = () => {
    if (ask.isPending) return;
    const last = messages[messages.length - 1];
    const previous = messages[messages.length - 2];
    if (last?.role !== "assistant" || previous?.role !== "user") return;
    ask.mutate({ value: previous.text, regenerate: true });
  };

  const status = aiStatus.data;
  const lastResponse = [...messages]
    .reverse()
    .find((message) => message.response)?.response;
  const displayStatus = lastResponse?.ai_status ?? status;
  const allPlacesScope =
    !selection.householdId || Boolean(selection.propertyId);
  const modeLabel = lastResponse
    ? lastResponse.mode === "ai"
      ? "AI-assisted answer"
      : lastResponse.mode === "direct"
        ? "Direct inventory lookup"
        : displayStatus?.configured
          ? "AI unavailable · used basic mode"
          : "AI off · local answer"
    : "AI when needed · grounded in records";

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      <div className="shrink-0 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="eyebrow mb-1">Intelligence</p>
            <h1 className="display-title !text-[1.6rem] sm:!text-[2rem]">
              Assistant
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AddItemsButton variant="outline" />
            <Button
              type="button"
              variant="ghost"
              onClick={newConversation}
              disabled={ask.isPending || messages.length === 0}
            >
              <RotateCcw />
              New conversation
            </Button>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center gap-2">
          <SearchScopeSelect compact />
          <Badge
            variant={
              lastResponse?.mode === "ai"
                ? "brass"
                : lastResponse?.mode === "fallback"
                  ? "outline"
                  : "sage"
            }
          >
            <Sparkles className="size-3" />
            {modeLabel}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={infoOpen}
            aria-controls="assistant-info"
            onClick={() => setInfoOpen((open) => !open)}
          >
            <Info />
            Privacy &amp; model
          </Button>
          {infoOpen && (
            <div
              id="assistant-info"
              className="surface absolute left-0 top-full z-40 mt-2 w-[min(32rem,100%)] space-y-1.5 p-3.5 text-2xs leading-relaxed text-muted-foreground shadow-lg"
            >
              <p>
                {displayStatus?.available
                  ? "Provider available for this scope."
                  : displayStatus?.configured
                    ? "Provider configured; direct search still works."
                    : "No model configured; direct grounded results stay available."}
              </p>
              {displayStatus?.data_leaves_server && (
                <Badge variant="brass">
                  Remote transmission enabled with consent
                </Badge>
              )}
              <p>
                {allPlacesScope
                  ? "All-my-places answers are interpreted one household at a time using only that household's configured provider and consent. Read-only deterministic retrieval remains available when a household has no provider; no household's records are sent through another household's provider."
                  : (displayStatus?.privacy_note ??
                    "The assistant executes read-only household tools and answers from real records.")}
              </p>
              {status?.model && (
                <p>
                  Model: <span className="font-medium">{status.model}</span>
                  {status.provider_label ? ` · ${status.provider_label}` : ""}
                </p>
              )}
              {status?.error && <p className="text-brass">{status.error}</p>}
              <p>
                The assistant never creates, edits or deletes inventory from
                this conversation.{" "}
                <Link
                  to="/settings/ai"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  AI settings
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={paneRef}
          onScroll={updateNearBottom}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="h-full overflow-y-auto overscroll-contain pb-2"
        >
          <div className="mx-auto w-full max-w-5xl space-y-4">
            {messages.length === 0 && !ask.isPending && (
              <div className="flex flex-col items-center px-2 py-10 text-center">
                <Bot className="size-6 text-brass" strokeWidth={1.6} />
                <h2 className="mt-2 font-display text-[1.35rem] tracking-[-0.025em]">
                  Ask your home a question.
                </h2>
                <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
                  Answers come from your current records. Pick a suggestion
                  below or type your own.
                </p>
              </div>
            )}
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div key={index} className="flex justify-end">
                  <div
                    dir="auto"
                    className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-start text-sm leading-relaxed text-primary-foreground"
                  >
                    {message.text}
                  </div>
                </div>
              ) : (
                <div
                  key={index}
                  ref={
                    index === messages.length - 1 ? lastAnswerRef : undefined
                  }
                  className="scroll-mt-2"
                >
                  <AssistantAnswer
                    response={message.response}
                    text={message.text}
                    onRegenerate={
                      index === messages.length - 1 ? regenerateLatest : undefined
                    }
                    regenerateDisabled={ask.isPending}
                  />
                  {index === messages.length - 1 && !ask.isPending && (
                    <FollowUps
                      suggestions={followUpSuggestions(
                        message.response,
                        messages[index - 1]?.text ?? "",
                      )}
                      onAsk={askSuggestion}
                    />
                  )}
                </div>
              ),
            )}
            {ask.isPending && (
              <div className="surface flex items-center gap-3 p-5 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Retrieving current records across your places…
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>
        {!nearBottom && messages.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-3 rounded-full bg-card shadow-lg"
          >
            <ArrowDown />
            Jump to latest
          </Button>
        )}
      </div>

      <div className="shrink-0 pt-2">
        <div className="mx-auto w-full max-w-5xl">
          {messages.length === 0 && !ask.isPending && (
            <div
              className="-mx-1 mb-2 flex gap-2 overflow-x-auto overflow-y-hidden px-1 pb-1"
              aria-label="Suggested questions"
            >
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => askSuggestion(suggestion)}
                  className="shrink-0 rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <section className="surface bg-card/95 p-2.5 shadow-lg sm:p-3">
            <form onSubmit={submit}>
              <div className="flex items-end gap-2">
                <Textarea
                  ref={textareaRef}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="Ask about your inventory…"
                  aria-label="Ask the Housetory assistant"
                  rows={1}
                  maxLength={2000}
                  className="max-h-40 min-h-11 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
                />
                {dictation.supported && (
                  <Button
                    type="button"
                    size="icon"
                    variant={dictation.listening ? "default" : "ghost"}
                    aria-label={
                      dictation.listening ? "Stop dictation" : "Dictate question"
                    }
                    aria-pressed={dictation.listening}
                    onClick={dictation.toggle}
                    className={dictation.listening ? "animate-pulse" : undefined}
                  >
                    <Mic />
                  </Button>
                )}
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send question"
                  disabled={ask.isPending || question.trim().length < 2}
                >
                  {ask.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Send />
                  )}
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

function contextualLink(response: SearchQueryResponse): string | null {
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
    } else path = "/items";
  } else if (
    response.tool === "list_outstanding_loans" ||
    response.tool === "list_borrowed_items" ||
    response.tool === "find_borrowed_owner"
  )
    path = "/loans";
  else if (response.tool === "get_warranty_status") path = "/warranties";
  else if (response.tool === "search_documents") path = "/documents";
  else if (response.tool === "get_purchase_history") path = "/purchases";
  if (!path) return null;
  if ((response.households?.length ?? 0) > 1 || response.property) return null;
  return withHousehold(path, response.households?.[0]?.id);
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function FollowUps({
  suggestions,
  onAsk,
}: {
  suggestions: string[];
  onAsk: (value: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Follow-up questions">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onAsk(suggestion)}
          className="rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function AssistantAnswer({
  response,
  text,
  onRegenerate,
  regenerateDisabled,
}: {
  response?: SearchQueryResponse;
  text: string;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      toast.success("Answer copied");
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Couldn't copy — select the text and copy it manually.");
    }
  };
  const link = response ? contextualLink(response) : null;
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-sage-soft text-accent-foreground">
          <Bot className="size-3.5" />
        </span>
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Housetory
        </span>
        <Badge variant="outline">
          {response?.scope_label ?? "All my places"}
        </Badge>
        {response && (
          <Badge
            variant={
              response.mode === "ai"
                ? "brass"
                : response.mode === "fallback"
                  ? "outline"
                  : "sage"
            }
          >
            {response.mode === "ai"
              ? "AI-assisted"
              : response.mode === "fallback"
                ? response.ai_status?.configured
                  ? "AI unavailable · used basic mode"
                  : "AI off · local answer"
                : "Direct lookup"}
          </Badge>
        )}
      </div>
      <AnswerText
        text={text}
        direction={response?.answer_direction ?? "auto"}
        preserveTerms={response?.preserve_terms ?? []}
        className="mt-3 text-sm leading-[1.8] text-foreground/85"
      />
      {response && response.notices.length > 0 && (
        <ul className="mt-3 space-y-1 text-2xs leading-relaxed text-muted-foreground">
          {response.notices.map((notice) => (
            <li key={notice}>• {notice}</li>
          ))}
        </ul>
      )}
      {response && response.borrowed.length > 0 && (
        <div className="mt-4 space-y-2" aria-label="Borrowed records">
          {response.borrowed.slice(0, 8).map((record) => {
            const place = borrowedPlaceLabel(record);
            return (
              <Link
                key={record.id}
                to={withHousehold(
                  `/borrowed/${record.id}`,
                  record.household_id,
                )}
                className="flex items-center gap-2 rounded-xl border border-brass/25 bg-brass-soft/20 px-3 py-2 text-xs transition-colors hover:bg-brass-soft/35"
              >
                <HandCoins className="size-3.5 shrink-0 text-brass" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate">{record.item_name}</span>
                    <Badge variant="brass" className="text-2xs">
                      Borrowed
                    </Badge>
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    Belongs to {record.owner_name} ·{" "}
                    {borrowedLocationPrefix(record)} {place} ·{" "}
                    {record.outstanding_quantity} outstanding
                    {record.due_on ? ` · due ${record.due_on}` : ""}
                  </span>
                </span>
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      )}
      {response && response.items.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {response.items.slice(0, 8).map((item) => {
            const container = itemContainer(item);
            const place =
              [
                item.property?.name,
                item.room?.name,
                container
                  ? locationLabel(container)
                  : item.location
                    ? locationLabel(item.location)
                    : null,
              ]
                .filter(Boolean)
                .join(" / ") || "No place recorded";
            return (
              <Link
                key={item.id}
                to={withHousehold(`/items/${item.id}`, item.household?.id)}
                className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs transition-colors hover:bg-secondary/40"
              >
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.name}</span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {place}
                    {item.on_loan_quantity
                      ? ` · ${item.on_loan_quantity} on loan`
                      : ""}
                  </span>
                </span>
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      )}
      {response && response.documents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {response.documents.slice(0, 5).map((document) => (
            <Link
              key={document.id}
              to={withHousehold(
                String(document.url),
                document.household_id ? String(document.household_id) : null,
              )}
            >
              <Badge
                variant="secondary"
                className="gap-1 hover:bg-secondary/70"
              >
                <FileText className="size-3" />
                {document.title}
              </Badge>
            </Link>
          ))}
        </div>
      )}
      {response && response.references.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Sources
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response.references.slice(0, 12).map((reference) => (
              <Link
                key={`${reference.type}-${reference.id}`}
                to={withHousehold(reference.url, reference.household_id)}
              >
                <Badge variant="outline" className="hover:bg-secondary">
                  {reference.title}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}
      {link && (
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <Link to={link}>Open matching records</Link>
          </Button>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1 border-t border-border/60 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          Copy answer
        </Button>
        {onRegenerate && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerateDisabled}
          >
            <RotateCcw />
            Regenerate
          </Button>
        )}
      </div>
    </div>
  );
}
