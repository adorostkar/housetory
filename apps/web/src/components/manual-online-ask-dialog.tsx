import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Globe2, Loader2 } from "lucide-react";
import * as React from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import type {
  ItemDetail,
  ItemManuals,
  ManualAnswerMode,
  ManualOnlineAnswer,
  WebCitation,
} from "@/lib/types";

const MODE_LABELS: Record<ManualAnswerMode, string> = {
  ai: "AI summary of online sources",
  extractive: "Quoted from online sources",
  no_evidence: "No matching online source",
};

const MODE_TONES: Record<ManualAnswerMode, "sage" | "outline" | "brass"> = {
  ai: "sage",
  extractive: "outline",
  no_evidence: "brass",
};

/**
 * A question sent to the configured online search service. Questions about attached
 * manuals go to the assistant instead, which reads their pages.
 */
export function ManualOnlineAskDialog({
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
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState<ManualOnlineAnswer | null>(null);
  const [armed, setArmed] = React.useState(false);

  const online = useMutation({
    mutationFn: (value: string) =>
      api.post<ManualOnlineAnswer>(`/items/${item.id}/manual-questions/online`, {
        question: value,
      }),
    onSuccess: (data) => {
      setAnswer(data);
      setArmed(false);
    },
  });

  React.useEffect(() => {
    if (!open) {
      setQuestion("");
      setAnswer(null);
      setArmed(false);
      online.reset();
    }
    // Reset only when the dialog closes; the mutation object is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const profile = manuals?.search.profile;
  const canAsk = Boolean(manuals?.search.configured && profile && manuals.search.can_search);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ask online sources about {item.name}</DialogTitle>
          <DialogDescription>
            Optional. Only the confirmed product identity, variant and your question are sent
            to the configured search service. Borrower, loan and household data are never
            included. For questions about an attached manual, ask the assistant.
          </DialogDescription>
        </DialogHeader>

        {profile && (
          <p className="break-all text-2xs text-muted-foreground">
            {profile.manufacturer} · {profile.model_identifier}
            {profile.variant ? ` · ${profile.variant}` : ""}
          </p>
        )}

        {!canAsk ? (
          <p className="rounded-lg border border-border/60 bg-secondary/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            {manuals?.search.reason ??
              "A real online search service must be configured by the operator before online questions can be used."}
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!question.trim()) return;
              online.reset();
              setArmed(true);
            }}
          >
            <Field label="Question" htmlFor="manual-online-question">
              <Textarea
                id="manual-online-question"
                value={question}
                maxLength={1000}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setArmed(false);
                }}
                placeholder="How do I change the drill bit?"
                disabled={online.isPending}
              />
            </Field>
            {!armed && (
              <div className="flex justify-end">
                <Button type="submit" variant="outline" disabled={!question.trim()}>
                  <Globe2 />
                  Review online request
                </Button>
              </div>
            )}
          </form>
        )}

        {canAsk && armed && (
          <div className="space-y-3 rounded-lg border border-brass/25 bg-brass-soft/25 p-3">
            <p className="text-2xs leading-relaxed">
              Send this question to the configured online search service? Results are external
              sources and are cited by URL. No household inventory or loan data is sent.
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
                onClick={() => setArmed(false)}
                disabled={online.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {online.error && <FormError message={getApiErrorMessage(online.error)} />}

        {answer && (
          <section className="space-y-3 rounded-xl border border-border/70 bg-secondary/15 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={MODE_TONES[answer.mode]}>{MODE_LABELS[answer.mode]}</Badge>
              <Badge variant="brass">Online sources</Badge>
            </div>
            <p className="whitespace-pre-line text-pretty text-sm leading-[1.7]">
              {answer.answer}
            </p>
            {answer.citations.length > 0 && (
              <ul className="max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-1">
                {answer.citations.map((citation, index) => (
                  <li key={`${citation.url}-${index}`}>
                    <WebCitationItem citation={citation} />
                  </li>
                ))}
              </ul>
            )}
            {answer.notices.length > 0 && (
              <ul className="space-y-1 text-2xs leading-relaxed text-muted-foreground">
                {answer.notices.map((notice, index) => (
                  <li key={`${notice}-${index}`}>{notice}</li>
                ))}
              </ul>
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

function WebCitationItem({ citation }: { citation: WebCitation }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
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
      <p className="mt-1.5 line-clamp-3 text-2xs leading-relaxed text-muted-foreground">
        {citation.excerpt || "No excerpt was supplied by the source."}
      </p>
      <p className="mt-1 break-all text-2xs text-muted-foreground">{citation.url}</p>
    </div>
  );
}
