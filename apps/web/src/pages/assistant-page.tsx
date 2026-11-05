import { useMutation } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bot,
  FileText,
  Loader2,
  MapPin,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { AddItemsButton } from "@/components/add-items";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { useAiStatus } from "@/lib/queries";
import type { AssistantResponse } from "@/lib/types";
import { itemContainer, locationLabel } from "@/lib/utils";

const SUGGESTIONS = [
  "Where is my heavy drill?",
  "Which items have no purchase information?",
  "What is on loan?",
  "What do I have stored in the attic?",
  "Which warranties are expiring soon?",
  "How many suitcases do I own?",
];

interface Message {
  role: "user" | "assistant";
  text: string;
  response?: AssistantResponse;
}

export function AssistantPage() {
  const aiStatus = useAiStatus();
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [question, setQuestion] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);
  const autoAskedRef = React.useRef<string | null>(null);

  const ask = useMutation({
    mutationFn: (value: string) => {
      const history = messages.slice(-8).map((message) => ({
        role: message.role,
        content: message.text,
      }));
      return api.post<AssistantResponse>("/assistant/query", {
        question: value,
        history,
      });
    },
    onSuccess: (response, value) => {
      setMessages((current) => [
        ...current,
        { role: "user", text: value },
        { role: "assistant", text: response.answer, response },
      ]);
      setQuestion("");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  React.useEffect(() => {
    const value = searchParams.get("q")?.trim() ?? "";
    if (value.length < 2 || autoAskedRef.current === value) return;
    autoAskedRef.current = value;
    ask.mutate(value);
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
  }, [searchParams, setSearchParams]);

  React.useEffect(() => {
    if (typeof endRef.current?.scrollIntoView === "function") {
      endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, ask.isPending]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = question.trim();
    if (value.length < 2 || ask.isPending) return;
    ask.mutate(value);
  };

  const askSuggestion = (value: string) => {
    setQuestion("");
    ask.mutate(value);
  };

  const status = aiStatus.data;
  const modeLabel =
    status?.mode === "local"
      ? "Local AI"
      : status?.mode === "private"
        ? "Private-network AI"
        : status?.mode === "cloud"
          ? "Remote AI"
          : "Grounded mode";

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Intelligence"
        title="Assistant"
        description="Ask practical questions about your actual inventory, documents, purchases, loans and warranties."
        actions={
          <>
            <AddItemsButton variant="outline" />
            <Button variant="outline" asChild>
              <Link to="/settings/ai">
                <ShieldCheck />
                AI settings
              </Link>
            </Button>
          </>
        }
      />

      <section className="surface p-3.5 sm:p-4">
        <form onSubmit={submit}>
          <div className="flex items-end gap-2">
            <Textarea
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
              className="min-h-11 resize-none border-0 bg-transparent text-[0.9rem] focus-visible:ring-0"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send question"
              disabled={ask.isPending || question.trim().length < 2}
            >
              {ask.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[0.68rem] text-muted-foreground">
          <Badge
            variant={
              status?.mode === "local"
                ? "sage"
                : status?.mode === "private" || status?.mode === "cloud"
                  ? "brass"
                  : "outline"
            }
          >
            <Sparkles className="size-3" />
            {modeLabel}
          </Badge>
          <span>
            {status?.available
              ? "Provider available"
              : status?.configured
                ? "Provider configured; deterministic answers still work"
                : "No model configured; grounded answers stay available"}
          </span>
          {status?.data_leaves_server && (
            <Badge variant="brass">Remote transmission enabled with consent</Badge>
          )}
          <details className="ml-auto">
            <summary className="cursor-pointer select-none underline-offset-4 hover:text-foreground hover:underline">
              Privacy &amp; model details
            </summary>
            <div className="mt-2 max-w-xl space-y-1.5 rounded-lg border border-border/60 bg-background/50 p-3 text-[0.7rem] leading-relaxed">
              <p>
                {status?.privacy_note ??
                  "The assistant executes read-only household tools and answers from real records."}
              </p>
              {status?.model && (
                <p>
                  Model: <span className="font-medium">{status.model}</span>
                  {status.provider_label ? ` · ${status.provider_label}` : ""}
                </p>
              )}
              {status?.error && <p className="text-brass">{status.error}</p>}
              <p>
                The assistant never creates, edits or deletes inventory from this
                conversation. Long questions and answers stay on this page.
              </p>
            </div>
          </details>
        </div>
      </section>

      {messages.length === 0 && !ask.isPending ? (
        <section className="surface mt-4 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-brass" strokeWidth={1.6} />
            <h2 className="font-display text-[1.35rem] tracking-[-0.025em]">
              Ask your home a question.
            </h2>
          </div>
          <p className="mt-2 max-w-2xl text-[0.8rem] leading-relaxed text-muted-foreground">
            Housetory retrieves current records first, then answers. Structured
            questions such as loans and missing information are resolved directly from
            the database.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => askSuggestion(suggestion)}
                disabled={ask.isPending}
                className="rounded-xl border border-border/70 bg-background/40 px-4 py-3 text-left text-[0.78rem] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground disabled:opacity-60"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="mt-5 space-y-4">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-[0.84rem] leading-relaxed text-primary-foreground">
                  {message.text}
                </div>
              </div>
            ) : (
              <AssistantAnswer key={index} response={message.response} text={message.text} />
            ),
          )}
          {ask.isPending && (
            <div className="surface flex items-center gap-3 p-5 text-[0.82rem] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Retrieving current household records…
            </div>
          )}
        </section>
      )}
      <div ref={endRef} />
    </div>
  );
}

function contextualLink(response: AssistantResponse): string | null {
  if (response.tool === "find_missing_information") {
    const criterion = String(response.facts.criterion ?? "");
    if (criterion === "missing_purchase") return "/items?purchase_info=missing";
    if (criterion === "missing_purchase_date") {
      return "/items?purchase_info=missing_date";
    }
    if (criterion === "missing_purchase_price") {
      return "/items?purchase_info=missing_price";
    }
    if (criterion === "purchase_unknown") return "/items?purchase_info=unknown";
    if (criterion === "purchase_not_applicable") {
      return "/items?purchase_info=not_applicable";
    }
    return "/items";
  }
  if (response.tool === "list_outstanding_loans") return "/loans";
  if (response.tool === "get_warranty_status") return "/warranties";
  if (response.tool === "search_documents") return "/documents";
  if (response.tool === "get_purchase_history") return "/purchases";
  return null;
}

function AssistantAnswer({
  response,
  text,
}: {
  response?: AssistantResponse;
  text: string;
}) {
  const link = response ? contextualLink(response) : null;
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-sage-soft text-accent-foreground">
          <Bot className="size-3.5" />
        </span>
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Housetory
        </span>
      </div>
      <div className="mt-3 whitespace-pre-line text-[0.86rem] leading-[1.8] text-foreground/85">
        {text}
      </div>
      {response && response.items.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {response.items.slice(0, 8).map((item) => {
            const container = itemContainer(item);
            const place = [
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
                to={`/items/${item.id}`}
                className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-[0.76rem] transition-colors hover:bg-secondary/40"
              >
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.name}</span>
                  <span className="block truncate text-[0.66rem] text-muted-foreground">
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
            <Link key={document.id} to={document.url}>
              <Badge variant="secondary" className="gap-1 hover:bg-secondary/70">
                <FileText className="size-3" />
                {document.title}
              </Badge>
            </Link>
          ))}
        </div>
      )}
      {response && response.references.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Sources
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response.references.slice(0, 12).map((reference) => (
              <Link key={`${reference.type}-${reference.id}`} to={reference.url}>
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
    </div>
  );
}
