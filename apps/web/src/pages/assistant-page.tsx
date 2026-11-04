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
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { useAiStatus } from "@/lib/queries";
import type { AssistantResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "Where is my camera?",
  "What do I have stored in the attic?",
  "Which items have no purchase information?",
  "Which warranties are expiring soon?",
  "How many suitcases do I own?",
  "Show me electronics stored outside the office.",
];

interface Message {
  role: "user" | "assistant";
  text: string;
  response?: AssistantResponse;
}

export function AssistantPage() {
  const aiStatus = useAiStatus();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [question, setQuestion] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);

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
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, ask.isPending]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = question.trim();
    if (value.length < 2 || ask.isPending) return;
    ask.mutate(value);
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Intelligence"
        title="Assistant"
        description="Ask practical questions about your actual inventory, documents, purchases and warranties."
        actions={
          <Button variant="outline" asChild>
            <Link to="/settings">
              <ShieldCheck />
              AI status
            </Link>
          </Button>
        }
      />

      <section
        className={cn(
          "surface p-4 sm:p-5",
          aiStatus.data?.mode === "disabled" && "border-border/70",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              aiStatus.data?.mode === "local"
                ? "sage"
                : aiStatus.data?.mode === "cloud"
                  ? "brass"
                  : "outline"
            }
          >
            <Sparkles className="size-3" />
            {aiStatus.data?.mode === "local"
              ? "Local AI"
              : aiStatus.data?.mode === "cloud"
                ? "Cloud AI"
                : "Grounded mode"}
          </Badge>
          {aiStatus.data?.model && (
            <span className="text-[0.72rem] text-muted-foreground">
              {aiStatus.data.model}
            </span>
          )}
          {aiStatus.data?.available ? (
            <Badge variant="sage">Available</Badge>
          ) : (
            <Badge variant="outline">Model unavailable</Badge>
          )}
          {aiStatus.data?.data_leaves_server && (
            <Badge variant="brass">Cloud transmission enabled with consent</Badge>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-[0.75rem] leading-relaxed text-muted-foreground">
          {aiStatus.data?.privacy_note ??
            "The assistant executes read-only household tools and answers from real records."}
          {aiStatus.data?.mode === "disabled" &&
            " Chat still works using deterministic grounded answers; configure Ollama for model-written phrasing."}
        </p>
        {aiStatus.data?.error && aiStatus.data.mode !== "disabled" && (
          <p className="mt-2 text-[0.72rem] text-brass">{aiStatus.data.error}</p>
        )}
      </section>

      <section className="mt-6 space-y-4">
        {messages.length === 0 ? (
          <div className="surface p-6 sm:p-8">
            <div className="flex items-center gap-2">
              <Bot className="size-5 text-brass" strokeWidth={1.6} />
              <h2 className="font-display text-[1.5rem] tracking-[-0.025em]">
                Ask your home a question.
              </h2>
            </div>
            <p className="mt-2 max-w-2xl text-[0.82rem] leading-relaxed text-muted-foreground">
              Housetory retrieves records first, then answers. It cannot create, edit or
              delete anything from this conversation.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setQuestion(suggestion);
                    ask.mutate(suggestion);
                  }}
                  className="rounded-xl border border-border/70 bg-background/40 px-4 py-3 text-left text-[0.78rem] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-[0.84rem] leading-relaxed text-primary-foreground">
                  {message.text}
                </div>
              </div>
            ) : (
              <AssistantAnswer key={index} response={message.response} text={message.text} />
            ),
          )
        )}
        {ask.isPending && (
          <div className="surface flex items-center gap-3 p-5 text-[0.82rem] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Retrieving household records…
          </div>
        )}
      </section>

      <form onSubmit={submit} className="surface mt-4 rounded-2xl border border-border/70 p-2.5">
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
            placeholder="Where is my camera? What is stored in the blue boxes?"
            aria-label="Ask the Housetory assistant"
            rows={1}
            maxLength={2000}
            className="min-h-10 resize-none border-0 bg-transparent focus-visible:ring-0"
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
        <div ref={endRef} />
      </form>
    </div>
  );
}

function AssistantAnswer({
  response,
  text,
}: {
  response?: AssistantResponse;
  text: string;
}) {
  return (
    <div className="surface p-5">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-sage-soft text-accent-foreground">
          <Bot className="size-3.5" />
        </span>
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Housetory
        </span>
        {response && (
          <Badge variant={response.mode === "ai" ? "sage" : "outline"}>
            {response.mode === "ai" ? "Model answer" : "Grounded answer"}
          </Badge>
        )}
      </div>
      <div className="mt-3 whitespace-pre-line text-[0.86rem] leading-[1.8] text-foreground/85">
        {text}
      </div>
      {response && response.items.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {response.items.slice(0, 6).map((item) => (
            <Link
              key={item.id}
              to={`/items/${item.id}`}
              className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-[0.76rem] transition-colors hover:bg-secondary/40"
            >
              <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-[0.68rem] text-muted-foreground">
                {item.room?.name ?? "No room"}
              </span>
              <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
            </Link>
          ))}
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
            {response.references.slice(0, 10).map((reference) => (
              <Link key={`${reference.type}-${reference.id}`} to={reference.url}>
                <Badge variant="outline" className="hover:bg-secondary">
                  {reference.title}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
