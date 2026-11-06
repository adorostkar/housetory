import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, History, Loader2 } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  useCanWrite,
  useStocktakeScopeSummary,
  useStocktakeSessions,
} from "@/lib/queries";
import type { StocktakeSession } from "@/lib/types";
import { cn, formatDate, pluralize } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  completed: "Completed",
  abandoned: "Abandoned",
};

const STATUS_TONES = {
  in_progress: "brass",
  completed: "sage",
  abandoned: "secondary",
} as const;

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function coverageLabel(session: StocktakeSession) {
  return `${session.checked_item_count} of ${pluralize(
    session.expected_item_count,
    "item",
  )} checked`;
}

export function StocktakeEntry({
  roomId,
  containerId,
}: {
  roomId?: string;
  containerId?: string;
}) {
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const summary = useStocktakeScopeSummary({ roomId, containerId });
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const requestId = React.useRef(newRequestId());
  const active = summary.data?.active_session ?? null;
  const last = summary.data?.last_completed_session ?? null;
  const history = useStocktakeSessions(
    { roomId, containerId },
    historyOpen,
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["stocktake"] });
  };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const session = await api.post<StocktakeSession>("/stocktake/sessions", {
        room_ids: roomId ? [roomId] : [],
        container_ids: containerId ? [containerId] : [],
        include_descendants: true,
        request_id: requestId.current,
      });
      requestId.current = newRequestId();
      invalidate();
      navigate(`/stocktake/${session.id}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const current = active ?? last;
  return (
    <>
      <section className="surface mb-4 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <ClipboardCheck className="size-3.5" />
            Stocktake
          </span>
          {summary.isPending ? (
            <span className="text-[0.74rem] text-muted-foreground">Reading checks…</span>
          ) : current ? (
            <span className="min-w-0 text-[0.76rem] text-muted-foreground">
              {active ? (
                <>
                  <span className="font-medium text-foreground">In progress</span> ·{" "}
                  {coverageLabel(active)}
                </>
              ) : (
                <>
                  Last checked {formatDate(last?.completed_at)} ·{" "}
                  {coverageLabel(last as StocktakeSession)}
                  {last?.partial ? " · partial" : ""}
                </>
              )}
            </span>
          ) : (
            <span className="text-[0.76rem] text-muted-foreground">
              No completed stocktake recorded for this {roomId ? "room" : "container"} yet.
            </span>
          )}
          {current && (
            <Badge variant={STATUS_TONES[current.status]}>
              {STATUS_LABELS[current.status]}
            </Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {current && (
              <Button size="sm" variant="ghost" asChild>
                <Link to={`/stocktake/${current.id}`}>
                  {active ? "Resume" : "View last"}
                </Link>
              </Button>
            )}
            {canWrite && !active && (
              <Button size="sm" variant="outline" onClick={() => void start()} disabled={starting}>
                {starting ? <Spinner /> : <ClipboardCheck />}
                Start stocktake
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setHistoryOpen(true)}
              aria-label="Stocktake history"
            >
              <History />
              History
            </Button>
          </div>
        </div>
        {active && (
          <p className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
            Progress is saved as you check items. Loan units are recorded separately and are
            never marked missing.
          </p>
        )}
        <p className="mt-1 text-[0.66rem] leading-relaxed text-muted-foreground">
          Borrowed-from-others records are kept separate and are never added to owned
          stocktake quantities.
        </p>
      </section>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Stocktake history</DialogTitle>
            <DialogDescription>
              Past checks for this {roomId ? "room" : "container"}. Completed and abandoned
              sessions keep their observations.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {history.isPending ? (
              <div className="flex items-center gap-2 px-1 py-6 text-[0.78rem] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading sessions…
              </div>
            ) : history.data?.items.length ? (
              <ul className="divide-y divide-border/50">
                {history.data.items.map((session) => (
                  <li key={session.id} className="flex flex-wrap items-center gap-2 py-3">
                    <Link
                      to={`/stocktake/${session.id}`}
                      className="min-w-0 flex-1 rounded-lg px-1 py-1 hover:bg-secondary/35"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[0.8rem] font-medium">
                          {formatDate(session.completed_at ?? session.started_at)}
                        </span>
                        <Badge variant={STATUS_TONES[session.status]}>
                          {STATUS_LABELS[session.status]}
                        </Badge>
                        {session.partial && session.status === "completed" && (
                          <Badge variant="outline">Partial</Badge>
                        )}
                      </span>
                      <span className="mt-1 block text-[0.68rem] text-muted-foreground">
                        {coverageLabel(session)} · {session.created_by_name}
                        {session.missing_item_count
                          ? ` · ${session.missing_item_count} missing`
                          : ""}
                        {session.quantity_discrepancy_count
                          ? ` · ${session.quantity_discrepancy_count} quantity`
                          : ""}
                      </span>
                    </Link>
                    <span
                      className={cn(
                        "text-[0.65rem] text-muted-foreground",
                        session.status === "in_progress" && "text-brass",
                      )}
                    >
                      {session.status === "in_progress" ? "Resume" : "View"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-[0.76rem] text-muted-foreground">
                No stocktake sessions for this scope yet.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
