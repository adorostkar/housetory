import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleSlash } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FormError } from "@/components/form-field";
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
import { api, getApiErrorMessage } from "@/lib/api";
import type { StocktakeSession } from "@/lib/types";
import { cn, pluralize } from "@/lib/utils";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function StocktakeFinishDialog({
  open,
  onOpenChange,
  session,
  mode,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: StocktakeSession;
  mode: "complete" | "abandon";
  onCompleted: (session: StocktakeSession) => void;
}) {
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());
  const checked = session.checked_item_count;
  const expected = session.expected_item_count;
  const unchecked = Math.max(0, expected - checked);
  const unknown = session.unknown_item_count;
  const partial = checked < expected || unknown > 0;
  const coverage = session.coverage as Record<string, unknown>;
  const completed = session.status === "completed";

  React.useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setError(null);
    requestId.current = newRequestId();
  }, [open, mode, session.id]);

  const submit = async () => {
    setError(null);
    if (mode === "complete" && partial && !acknowledged) {
      setError("Confirm that you understand this will be a partial stocktake.");
      return;
    }
    setPending(true);
    try {
      const result = await api.post<StocktakeSession>(
        `/stocktake/sessions/${session.id}/${mode === "complete" ? "complete" : "abandon"}`,
        {
          request_id: requestId.current,
          ...(mode === "complete"
            ? { acknowledge_partial: partial ? acknowledged : true }
            : {}),
        },
      );
      await queryClient.invalidateQueries({ queryKey: ["stocktake"] });
      toast.success(mode === "complete" ? "Stocktake completed" : "Stocktake abandoned");
      onCompleted(result);
      onOpenChange(false);
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "complete" ? "Finish stocktake" : "Abandon this stocktake?"}
          </DialogTitle>
          <DialogDescription>
            {mode === "complete"
              ? "Only explicitly checked items are verified. Unchecked items stay unverified."
              : "Observations are kept as history, but this session will not claim a completed check and will not update last-verified dates."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/65 px-3 py-3 text-[0.76rem] sm:grid-cols-4">
            <Metric label="Expected" value={expected} />
            <Metric label="Checked" value={checked} />
            <Metric label="Unchecked" value={unchecked} tone={unchecked ? "brass" : undefined} />
            <Metric label="Unexpected" value={session.unexpected_count} />
          </div>

          {(session.missing_item_count > 0 ||
            session.quantity_discrepancy_count > 0 ||
            unknown > 0) && (
            <div className="space-y-1 rounded-xl border border-brass/20 bg-brass-soft/25 px-3 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
              {session.missing_item_count > 0 && (
                <p>{pluralize(session.missing_item_count, "missing observation")} recorded.</p>
              )}
              {session.quantity_discrepancy_count > 0 && (
                <p>
                  {pluralize(
                    session.quantity_discrepancy_count,
                    "quantity discrepancy",
                    "quantity discrepancies",
                  )}{" "}
                  recorded.
                </p>
              )}
              {unknown > 0 && <p>{pluralize(unknown, "item")} marked couldn’t check.</p>}
              <p>These remain visible in the completed summary and item history.</p>
            </div>
          )}

          {completed && (
            <div className="rounded-xl border border-sage/20 bg-sage-soft/30 px-3 py-2.5 text-[0.72rem] leading-relaxed">
              <p className="font-medium">
                {coverage.partial ? "Completed with partial coverage" : "Completed"}
              </p>
              <p className="mt-1 text-muted-foreground">
                {String(coverage.checked_items ?? checked)} of {expected} expected items checked ·{" "}
                {String(coverage.checked_at_home_units ?? session.checked_unit_count)} at-home
                units counted.
              </p>
            </div>
          )}

          {mode === "complete" && partial && !completed && (
            <div className="rounded-xl border border-brass/25 bg-brass-soft/30 px-3 py-2.5 text-[0.72rem] leading-relaxed">
              <p className="flex items-start gap-2 font-medium text-brass">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                This is a partial stocktake.
              </p>
              <p className="mt-1 text-muted-foreground">
                {unchecked} expected {unchecked === 1 ? "item is" : "items are"} unchecked
                {unknown ? ` and ${unknown} ${unknown === 1 ? "is" : "are"} marked couldn’t check` : ""}.
                They will not be marked present or verified.
              </p>
              <label className="mt-2 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand this records partial coverage and will not claim the whole scope was
                  verified.
                </span>
              </label>
            </div>
          )}

          {mode === "abandon" && (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/[0.06] px-3 py-2.5 text-[0.72rem] leading-relaxed text-destructive">
              <CircleSlash className="mt-0.5 size-3.5 shrink-0" />
              This cannot be resumed. The observations stay inspectable, but no item last-checked
              dates will be updated.
            </p>
          )}

          {error && <FormError message={error} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep editing
          </Button>
          <Button
            type="button"
            variant={mode === "abandon" ? "destructive" : "default"}
            onClick={() => void submit()}
            disabled={pending || (mode === "complete" && partial && !acknowledged)}
          >
            {pending ? <Spinner /> : mode === "complete" ? <Check /> : <CircleSlash />}
            {mode === "complete" ? "Complete stocktake" : "Abandon stocktake"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "brass";
}) {
  return (
    <div>
      <p className="text-[0.62rem] uppercase tracking-[0.09em] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 font-display text-[1.15rem] tabular-nums", tone === "brass" && "text-brass")}>
        {value}
      </p>
    </div>
  );
}
