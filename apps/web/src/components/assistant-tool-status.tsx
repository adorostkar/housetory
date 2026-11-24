import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AnswerText } from "@/components/answer-text";
import { InventoryReview } from "@/components/inventory-review";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  assistantAnswerText, startedReview, type AssistantManualLink, type AssistantToolRun,
} from "@/lib/assistant-tools";
import { withHousehold } from "@/lib/household-links";
import { useSelectHousehold, useSession } from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";

const MANUAL_STATES: Record<AssistantManualLink["state"], string | null> = {
  readable: null,
  ocr_pending: "Text is still being read",
  ocr_failed: "Text could not be read",
  no_text: "No text read yet",
};

export function AssistantToolStatus({ run }: { run: AssistantToolRun }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const selectHousehold = useSelectHousehold();
  const [busy, setBusy] = React.useState(false);
  const active = ["queued", "running"].includes(run.state);
  const references = [...new Map(run.steps.flatMap(({ result }) =>
    result.references ?? []).map((reference) => [reference.id, reference])).values()];
  // Manuals are shown with their own links, not as a review: Open shows the file itself.
  const manuals = [...new Map(run.steps.flatMap(({ result }) =>
    result.manuals ?? []).map((manual) => [manual.document_id, manual])).values()];
  // The pages the answer rests on. Earlier versions stored them with each step.
  const citations = [...new Map([
    ...(run.citations ?? []), ...run.steps.flatMap(({ result }) => result.citations ?? []),
  ].map((citation) => [
      `${citation.document_id}:${citation.page ?? citation.section}:${citation.excerpt.slice(0, 60)}`,
      citation,
    ])).values()];
  // The stored file is served for the active household only. The pages switch household.
  const sameHousehold = session.data?.household?.id === run.household_id;
  const sourceReferences = references.filter((reference) =>
    !manuals.some((manual) => manual.document_id === reference.id));
  const reviews = [...new Map(run.steps.flatMap((step) => {
    const review = startedReview(step);
    return review ? [review] : [];
  }).map((review) => [review.id, review])).values()];
  const hasPreparedWork = run.steps.some((step) =>
    step.result.proposal || startedReview(step) || step.result.capture);
  const change = async (action: "cancel" | "retry") => {
    setBusy(true);
    try {
      await api.post(`/assistant/runs/${run.id}/${action}`, {});
      await queryClient.invalidateQueries({ queryKey: queryKeys.assistantRunsAll });
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${hasPreparedWork && !reviews.length && !active && !run.can_retry
      ? "px-1" : "surface p-4"} min-w-0 space-y-3`}
      aria-label="Assistant tool task" data-state={run.state}>
      {active ? <p role="status" className="text-sm">Working on your request…</p>
        : (!hasPreparedWork || run.can_retry) &&
          <AnswerText text={assistantAnswerText(run.message, references)} className="break-words" />}
      {active && run.worker_available === false && (
        <p className="text-xs text-brass">
          The AI worker is unavailable. Your request is saved; check the worker or use local/manual controls.
        </p>
      )}
      {(active || run.can_retry) && <div className="flex flex-wrap gap-2">
        {active && <Button className="min-h-11" variant="outline" disabled={busy}
          onClick={() => void change("cancel")}>Stop assistant</Button>}
        {run.can_retry && <Button className="min-h-11" variant="outline" disabled={busy}
          onClick={() => void change("retry")}>Retry assistant</Button>}
        {run.can_retry && <Link className="inline-flex min-h-11 items-center px-3 text-xs underline"
          to={withHousehold("/items", run.household_id)}>Local inventory controls</Link>}
      </div>}
      {manuals.length > 0 && (
        <ul className="space-y-1" aria-label="Manuals">
          {manuals.map((manual) => (
            <li key={manual.document_id} className="flex flex-wrap items-center gap-x-3 text-xs">
              <span className="min-w-0 break-words font-medium">{manual.title}</span>
              <Link to={withHousehold(manual.url, run.household_id)}
                className="inline-flex min-h-11 items-center underline"
                aria-label={`Open ${manual.title}`}>Open</Link>
              {sameHousehold && (
                <a href={manual.download_url} className="inline-flex min-h-11 items-center underline"
                  aria-label={`Download ${manual.title}`}>Download</a>
              )}
              {manual.details_url && (
                <Link to={withHousehold(manual.details_url, run.household_id)}
                  className="inline-flex min-h-11 items-center underline"
                  aria-label={`Details of ${manual.title}`}>Details</Link>
              )}
              {MANUAL_STATES[manual.state] ? (
                <span className="text-muted-foreground">{MANUAL_STATES[manual.state]}</span>
              ) : manual.pages && (manual.pages_read ?? manual.pages) < manual.pages ? (
                <span className="text-muted-foreground">
                  {manual.pages_read} of {manual.pages} pages read
                  {manual.pages_failed ? `, reading failed on ${manual.pages_failed}` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {citations.length > 0 && (
        <ul className="space-y-2" aria-label="Manual citations">
          {citations.map((citation, index) => {
            const place = citation.page ? `page ${citation.page}`
              : citation.section ?? `excerpt ${index + 1}`;
            const label = `${citation.document_title}, ${place}`;
            // A citation opens the file at its page, in the same viewer as Open.
            const manual = manuals.find((entry) => entry.document_id === citation.document_id);
            const viewer = citation.url.startsWith("/documents/") ? citation.url
              : manual ? `${manual.url}${citation.page ? `?page=${citation.page}` : ""}` : null;
            return (
              <li key={index} className="rounded-md border px-3 py-2">
                {viewer ? (
                  <Link className="text-xs font-medium underline"
                    to={withHousehold(viewer, run.household_id)}>{label}</Link>
                ) : (
                  <span className="text-xs font-medium">{label}</span>
                )}
                {citation.excerpt && (
                  <p className="mt-1 line-clamp-3 whitespace-pre-line break-words text-2xs text-muted-foreground">
                    “{citation.excerpt}”
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {sourceReferences.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Tool source records">
          {sourceReferences.map((reference) => (
            <Link key={reference.id} to={withHousehold(reference.url, run.household_id)}
              className="inline-flex min-h-11 items-center rounded-md border px-3 text-xs underline">
              {reference.title}
            </Link>
          ))}
        </div>
      )}
      {reviews.map((review) => {
        return (
          <div key={review.id} className="min-w-0">
            {session.data?.household?.id === run.household_id ? (
              <InventoryReview initialRun={review} assistantRunId={run.id} />
            ) : (
              <Button className="min-h-11" variant="outline" disabled={selectHousehold.isPending}
                onClick={() => selectHousehold.mutate(run.household_id)}>
                Switch to this review’s household
              </Button>
            )}
          </div>
        );
      })}
      <details className="text-2xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3">Diagnostics</summary>
        {(active || hasPreparedWork || assistantAnswerText(run.message, references) !== run.message) &&
          <p className="whitespace-pre-wrap break-words">{run.message}</p>}
        <ol className="mt-2 space-y-2">
          {run.steps.map((step, index) => (
            <li key={index} className="break-words">
              {step.call.name}: {step.result.summary}
              {step.result.error && <span className="text-destructive"> ({step.result.error})</span>}
            </li>
          ))}
        </ol>
        <p className="mt-2">{run.model_calls} model calls so far · up to {run.max_model_calls} per attempt</p>
        <p>Task: {run.id} · {run.state}</p>
      </details>
    </div>
  );
}
