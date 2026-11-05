import { useMutation } from "@tanstack/react-query";
import {
  BookOpen,
  ExternalLink,
  Globe2,
  Loader2,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { useInvalidateInventory } from "@/lib/queries";
import type {
  ItemDetail,
  ItemManuals,
  ManualAnswer,
  ManualAnswerMode,
  ManualCitation,
  ManualOnlineAnswer,
  WebCitation,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<ManualAnswerMode, string> = {
  ai: "AI-grounded from manual text",
  extractive: "Extracted from manual text",
  no_evidence: "No matching manual evidence",
};

const MODE_TONES: Record<ManualAnswerMode, "sage" | "outline" | "brass"> = {
  ai: "sage",
  extractive: "outline",
  no_evidence: "brass",
};

export function ManualAskDialog({
  item,
  manuals,
  open,
  onOpenChange,
}: {
  item: ItemDetail;
  manuals: ItemManuals | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateInventory();
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState<ManualAnswer | null>(null);
  const [onlineAnswer, setOnlineAnswer] = React.useState<ManualOnlineAnswer | null>(null);
  const [onlineArmed, setOnlineArmed] = React.useState(false);

  const ask = useMutation({
    mutationFn: (value: string) =>
      api.post<ManualAnswer>(`/items/${item.id}/manual-questions`, {
        question: value,
      }),
    onSuccess: (data) => {
      setAnswer(data);
      setOnlineAnswer(null);
      setOnlineArmed(false);
      invalidate();
    },
  });

  const online = useMutation({
    mutationFn: (value: string) =>
      api.post<ManualOnlineAnswer>(`/items/${item.id}/manual-questions/online`, {
        question: value,
      }),
    onSuccess: (data) => {
      setOnlineAnswer(data);
      setOnlineArmed(false);
    },
  });

  React.useEffect(() => {
    if (!open) {
      setQuestion("");
      setAnswer(null);
      setOnlineAnswer(null);
      setOnlineArmed(false);
      ask.reset();
      online.reset();
    }
    // Reset only when the dialog closes; mutation objects are stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const profile = manuals?.search.profile;
  const canAskOnline = Boolean(
    manuals?.search.configured && profile && manuals.search.can_search,
  );
  const manualCount = manuals?.manuals.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ask about {item.name}</DialogTitle>
          <DialogDescription>
            Answers use the text of {manualCount > 0 ? "the attached manuals" : "attached manuals"} first.
            Citations point to the real document page when page-level text exists, or to an
            explicit section/excerpt when it does not.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!question.trim()) return;
            ask.mutate(question.trim());
          }}
        >
          <Field
            label="Question"
            htmlFor="manual-question"
            hint={
              manualCount === 0
                ? "No manual attached yet"
                : `${manualCount} attached ${manualCount === 1 ? "manual" : "manuals"}`
            }
          >
            <Textarea
              id="manual-question"
              value={question}
              maxLength={1000}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="How do I change the drill bit?"
              disabled={ask.isPending}
            />
          </Field>
          {ask.error && <FormError message={getApiErrorMessage(ask.error)} />}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.68rem] leading-relaxed text-muted-foreground">
              Manuals are treated as untrusted source text. Missing or conflicting evidence is
              reported instead of guessed.
            </p>
            <Button type="submit" disabled={!question.trim() || ask.isPending}>
              {ask.isPending ? <Spinner /> : <MessageCircle />}
              Ask attached manuals
            </Button>
          </div>
        </form>

        {answer && (
          <section className="space-y-4 rounded-xl border border-border/70 bg-secondary/15 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={MODE_TONES[answer.mode]}>{MODE_LABELS[answer.mode]}</Badge>
              <Badge variant="outline">
                {answer.ai_status.configured ? "AI available" : "No AI required"}
              </Badge>
              <span className="text-[0.68rem] text-muted-foreground">
                Attached-manual answer
              </span>
            </div>

            <p className="whitespace-pre-line text-pretty text-[0.86rem] leading-[1.7]">
              {answer.answer}
            </p>

            {answer.citations.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Citations
                </h3>
                <ul className="max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {answer.citations.map((citation, index) => (
                    <li key={`${citation.document_id}-${citation.page ?? citation.section}-${index}`}>
                      <CitationItem citation={citation} index={index + 1} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {answer.manuals.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-[0.7rem]">
                <span className="text-muted-foreground">Sources:</span>
                {answer.manuals.map((manual) => (
                  <span key={manual.id} className="inline-flex items-center gap-1.5">
                    <Link
                      to={`/documents/${manual.id}`}
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      <BookOpen className="size-3" />
                      {manual.title}
                    </Link>
                    <a
                      href={manual.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Download ${manual.title}`}
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  </span>
                ))}
              </div>
            )}

            {answer.notices.length > 0 && (
              <ul className="space-y-1 border-t border-border/60 pt-3 text-[0.7rem] leading-relaxed text-muted-foreground">
                {answer.notices.map((notice, index) => (
                  <li key={`${notice}-${index}`} className="flex gap-1.5">
                    <ShieldCheck className="mt-0.5 size-3 shrink-0" />
                    <span>{notice}</span>
                  </li>
                ))}
              </ul>
            )}

            {answer.ai_status.configured && (
              <p className="text-[0.66rem] leading-relaxed text-muted-foreground">
                {answer.ai_status.provider_label ?? answer.ai_status.provider} ·{" "}
                {answer.ai_status.mode}. {answer.ai_status.privacy_note}
              </p>
            )}
          </section>
        )}

        {answer && profile && (
          <section className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-1.5 text-[0.78rem] font-medium">
                  <Globe2 className="size-3.5 text-muted-foreground" />
                  Ask configured online sources
                </h3>
                <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
                  Optional. Only the confirmed product identity, variant and your question are
                  sent to the configured search service. Borrower, loan and household data are
                  never included.
                </p>
                <p className="mt-1 break-all text-[0.66rem] text-muted-foreground">
                  {profile.manufacturer} · {profile.model_identifier}
                  {profile.variant ? ` · ${profile.variant}` : ""}
                </p>
              </div>
              {!canAskOnline ? (
                <Badge variant="outline">Online search not configured</Badge>
              ) : !onlineArmed ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOnlineArmed(true);
                    online.reset();
                  }}
                >
                  <Globe2 />
                  Review online request
                </Button>
              ) : null}
            </div>

            {!canAskOnline && (
              <p className="mt-2 rounded-lg border border-border/60 bg-secondary/25 px-3 py-2 text-[0.68rem] leading-relaxed text-muted-foreground">
                {manuals?.search.reason ??
                  "A real online search service must be configured by the operator before online questions can be used."}
              </p>
            )}

            {canAskOnline && onlineArmed && (
              <div className="mt-3 space-y-3 rounded-lg border border-brass/25 bg-brass-soft/25 p-3">
                <p className="text-[0.7rem] leading-relaxed">
                  Send this question to the configured online search service? Results are
                  external sources and are cited by URL. No household inventory or loan data is
                  sent.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => online.mutate(question.trim())}
                    disabled={online.isPending || !question.trim()}
                  >
                    {online.isPending ? <Loader2 className="animate-spin" /> : <Globe2 />}
                    Send online question
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setOnlineArmed(false)}
                    disabled={online.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {online.error && <FormError message={getApiErrorMessage(online.error)} />}

            {onlineAnswer && (
              <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={MODE_TONES[onlineAnswer.mode]}>
                    {MODE_LABELS[onlineAnswer.mode]}
                  </Badge>
                  <Badge variant="brass">Online sources</Badge>
                </div>
                <p className="whitespace-pre-line text-pretty text-[0.84rem] leading-[1.7]">
                  {onlineAnswer.answer}
                </p>
                {onlineAnswer.citations.length > 0 && (
                  <ul className="max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-1">
                    {onlineAnswer.citations.map((citation, index) => (
                      <li key={`${citation.url}-${index}`}>
                        <WebCitationItem citation={citation} />
                      </li>
                    ))}
                  </ul>
                )}
                {onlineAnswer.notices.length > 0 && (
                  <ul className="space-y-1 text-[0.7rem] leading-relaxed text-muted-foreground">
                    {onlineAnswer.notices.map((notice, index) => (
                      <li key={`${notice}-${index}`}>{notice}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CitationItem({ citation, index }: { citation: ManualCitation; index: number }) {
  const location = citation.page
    ? `Page ${citation.page}`
    : citation.section || `Excerpt ${index}`;
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem]">
        <a
          href={citation.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 font-medium underline-offset-4 hover:underline"
          aria-label={`${location}: ${citation.document_title}`}
        >
          <Badge variant="outline">{location}</Badge>
          <span className="truncate">{citation.document_title}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
        <Link
          to={`/documents/${citation.document_id}`}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Open document
        </Link>
      </div>
      <p className={cn("mt-1.5 whitespace-pre-line text-[0.72rem] leading-relaxed text-muted-foreground")}>
        {citation.excerpt}
      </p>
    </div>
  );
}

function WebCitationItem({ citation }: { citation: WebCitation }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem]">
        <Badge variant={citation.source_type === "manufacturer" ? "sage" : "outline"}>
          {citation.source_type === "manufacturer"
            ? "Manufacturer"
            : citation.source_type === "official"
              ? "Official"
              : "Web source"}
        </Badge>
        <a
          href={citation.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 font-medium underline-offset-4 hover:underline"
        >
          <span className="truncate">{citation.title}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
        {citation.publisher && (
          <span className="text-muted-foreground">{citation.publisher}</span>
        )}
        {citation.language && (
          <span className="text-muted-foreground">{citation.language}</span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-3 text-[0.72rem] leading-relaxed text-muted-foreground">
        {citation.excerpt || "No excerpt was supplied by the source."}
      </p>
      <p className="mt-1 break-all text-[0.62rem] text-muted-foreground/80">{citation.url}</p>
    </div>
  );
}
