import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AnswerText } from "@/components/answer-text";
import { InventoryReview } from "@/components/inventory-review";
import { api, getApiErrorMessage } from "@/lib/api";
import { assistantAnswerText, type AssistantToolRun } from "@/lib/assistant-tools";
import { withHousehold } from "@/lib/household-links";
import { useSelectHousehold, useSession } from "@/lib/queries";

export function AssistantToolStatus({ run }: { run: AssistantToolRun }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const selectHousehold = useSelectHousehold();
  const [busy, setBusy] = React.useState(false);
  const active = ["queued", "running"].includes(run.state);
  const references = [...new Map(run.steps.flatMap(({ result }) =>
    result.references ?? []).map((reference) => [reference.id, reference])).values()];
  const reviews = [...new Map(run.steps.flatMap(({ result }) =>
    result.review ? [result.review] : []).map((review) => [review.id, review])).values()];
  const hasPreparedWork = run.steps.some(({ result }) => result.proposal || result.review || result.capture);
  const change = async (action: "cancel" | "retry") => {
    setBusy(true);
    try {
      await api.post(`/assistant/runs/${run.id}/${action}`, {});
      await queryClient.invalidateQueries({ queryKey: ["assistant-runs"] });
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
      {references.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Tool source records">
          {references.map((reference) => (
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
