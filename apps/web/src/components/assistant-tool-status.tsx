import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import type { AssistantToolRun } from "@/lib/assistant-tools";
import { withHousehold } from "@/lib/household-links";
import { useSelectHousehold, useSession } from "@/lib/queries";
import { ReviewPage } from "@/pages/review-page";

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
    <div className="surface min-w-0 space-y-3 p-4" aria-label="Assistant tool task" data-state={run.state}>
      <p dir="auto" className="whitespace-pre-wrap break-words text-sm" role={active ? "status" : undefined}>
        {run.message}
      </p>
      {active && run.worker_available === false && (
        <p className="text-xs text-brass">
          The AI worker is unavailable. Your request is saved; check the worker or use local/manual controls.
        </p>
      )}
      <p className="text-2xs text-muted-foreground">
        {active ? "Working with application tools." : run.state === "awaiting_approval"
          ? "Tools prepared proposals. Nothing is applied automatically; use their explicit review actions."
          : "Tools have not applied inventory changes."}
      </p>
      <div className="flex flex-wrap gap-2">
        {active && <Button className="min-h-11" variant="outline" disabled={busy}
          onClick={() => void change("cancel")}>Stop assistant</Button>}
        {run.can_retry && <Button className="min-h-11" variant="outline" disabled={busy}
          onClick={() => void change("retry")}>Retry assistant</Button>}
        {run.can_retry && <Link className="inline-flex min-h-11 items-center px-3 text-xs underline"
          to={withHousehold("/items", run.household_id)}>Local inventory controls</Link>}
      </div>
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
        const params = new URLSearchParams({ scope_type: review.scope_type });
        if (review.scope_id) params.set("scope_id", review.scope_id);
        if (review.scope_item_ids?.length) params.set("item_ids", review.scope_item_ids.join(","));
        return (
          <details key={review.id} open className="min-w-0 border-t pt-3">
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              Inventory review · {review.scope_label}
            </summary>
            {session.data?.household?.id === run.household_id ? (
              <ReviewPage embedded initialRunId={review.id} initialParams={params.toString()} assistantRunId={run.id} />
            ) : (
              <Button className="min-h-11" variant="outline" disabled={selectHousehold.isPending}
                onClick={() => selectHousehold.mutate(run.household_id)}>
                Switch to this review’s household
              </Button>
            )}
          </details>
        );
      })}
      <details className="text-2xs text-muted-foreground">
        <summary className="cursor-pointer">Tool activity · {run.steps.length} results</summary>
        <ol className="mt-2 space-y-2">
          {run.steps.map((step, index) => (
            <li key={index} className="break-words">
              {step.call.name}: {step.result.summary}
              {step.result.error && <span className="text-destructive"> ({step.result.error})</span>}
            </li>
          ))}
        </ol>
        <p className="mt-2">{run.model_calls} model calls so far · up to {run.max_model_calls} per attempt</p>
      </details>
    </div>
  );
}
