import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  useCanWrite,
  useLocations,
  useRooms,
  useStocktakeSessions,
} from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";
import type { StocktakeSession } from "@/lib/types";
import { formatDate, pluralize } from "@/lib/utils";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SessionRow({ session }: { session: StocktakeSession }) {
  const active = session.status === "in_progress";
  const left = Math.max(0, session.expected_item_count - session.checked_item_count);
  return (
    <li>
      <Link
        to={`/stocktake/${session.id}`}
        state={{ fromStocktakeIndex: true }}
        className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-sm font-medium">{session.scope_label}</span>
            {!active && (
              <Badge variant={session.status === "completed" ? "sage" : "secondary"}>
                {session.status === "completed"
                  ? session.partial
                    ? "Completed · partial"
                    : "Completed"
                  : "Abandoned"}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {session.checked_item_count} of {pluralize(session.expected_item_count, "item")} checked
            {active ? ` · ${left} left` : ""} ·{" "}
            {active
              ? `started ${formatDate(session.started_at)}`
              : formatDate(session.completed_at ?? session.abandoned_at ?? session.started_at)}{" "}
            · {session.created_by_name}
          </span>
        </span>
        <span className="shrink-0 text-xs font-medium text-foreground">
          {active ? "Resume" : "View"}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

/** Stocktakes in one place: resume one, start one, or look at a finished one. */
export function StocktakeIndexPage() {
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeQuery = useStocktakeSessions({ status: "in_progress" });
  const recentQuery = useStocktakeSessions();
  const roomsQuery = useRooms(undefined, canWrite);
  const locationsQuery = useLocations(undefined, canWrite);
  const [place, setPlace] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());

  const active = activeQuery.data?.items ?? [];
  const finished = (recentQuery.data?.items ?? []).filter(
    (session) => session.status !== "in_progress",
  );
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const roomNames = new Map(rooms.map((room) => [room.id, room.name]));

  const separator = place.indexOf(":");
  const kind = place.slice(0, Math.max(separator, 0));
  const id = separator < 0 ? "" : place.slice(separator + 1);
  // Starting a second stocktake of the same place would only split the work.
  const running = active.find((session) =>
    kind === "room"
      ? session.scope.room_ids?.includes(id) && !session.scope.container_ids?.length
      : kind === "container"
        ? session.scope.container_ids?.includes(id) && !session.scope.room_ids?.length
        : false,
  );

  const start = async () => {
    if (starting || !id) return;
    setStarting(true);
    setError(null);
    try {
      const session = await api.post<StocktakeSession>("/stocktake/sessions", {
        room_ids: kind === "room" ? [id] : [],
        container_ids: kind === "container" ? [id] : [],
        include_descendants: true,
        request_id: requestId.current,
      });
      requestId.current = newRequestId();
      void queryClient.invalidateQueries({ queryKey: queryKeys.stocktake });
      navigate(`/stocktake/${session.id}`, { state: { fromStocktakeIndex: true } });
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Stocktake"
        title="Stocktake"
        description="Check that things are where your inventory says they are. Progress is saved after every item, so you can stop and go on later."
      />

      <div className="grid min-w-0 max-w-3xl gap-6">
        <section aria-labelledby="stocktake-active">
          <h2 id="stocktake-active" className="eyebrow mb-2 px-1">
            In progress
          </h2>
          {activeQuery.isPending ? (
            <Skeleton className="h-16 rounded-2xl" />
          ) : activeQuery.isError ? (
            <FormError message={getApiErrorMessage(activeQuery.error)} />
          ) : active.length ? (
            <ul className="surface divide-y divide-border/60 overflow-hidden">
              {active.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </ul>
          ) : (
            <p className="surface px-4 py-4 text-xs text-muted-foreground sm:px-5">
              No stocktake is in progress.
            </p>
          )}
        </section>

        {canWrite && (
          <section className="surface p-4 sm:p-5" aria-labelledby="stocktake-start">
            <h2 id="stocktake-start" className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              Start a stocktake
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Choose a room or a container. Everything inside it is included. Nothing in
              your inventory changes until you review and apply corrections.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 sm:flex-1">
                <Select
                  aria-label="Room or container to check"
                  className="h-11"
                  value={place}
                  disabled={roomsQuery.isPending || locationsQuery.isPending}
                  onChange={(event) => {
                    setPlace(event.target.value);
                    setError(null);
                  }}
                >
                  <option value="">Choose a room or container…</option>
                  {rooms.length > 0 && (
                    <optgroup label="Rooms">
                      {rooms.map((room) => (
                        <option key={room.id} value={`room:${room.id}`}>
                          {room.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {locations.length > 0 && (
                    <optgroup label="Containers and places">
                      {locations.map((location) => (
                        <option key={location.id} value={`container:${location.id}`}>
                          {location.identifier ? `${location.identifier} · ` : ""}
                          {location.name}
                          {roomNames.get(location.room_id)
                            ? ` (${roomNames.get(location.room_id)})`
                            : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </div>
              {running ? (
                <Button className="h-11" asChild>
                  <Link to={`/stocktake/${running.id}`} state={{ fromStocktakeIndex: true }}>
                    <ClipboardCheck />
                    Resume stocktake
                  </Link>
                </Button>
              ) : (
                <Button className="h-11" disabled={!id || starting} onClick={() => void start()}>
                  {starting ? <Spinner /> : <ClipboardCheck />}
                  Start stocktake
                </Button>
              )}
            </div>
            {running && (
              <p className="mt-2 text-2xs text-muted-foreground">
                A stocktake of this place is already in progress.
              </p>
            )}
            {!roomsQuery.isPending && rooms.length === 0 && (
              <p className="mt-2 text-2xs text-muted-foreground">
                Add a room first. A stocktake checks the items in a room or container.
              </p>
            )}
            {error && (
              <div className="mt-3">
                <FormError message={error} />
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="stocktake-finished">
          <h2 id="stocktake-finished" className="eyebrow mb-2 px-1">
            Recent
          </h2>
          {recentQuery.isPending ? (
            <Skeleton className="h-16 rounded-2xl" />
          ) : recentQuery.isError ? (
            <FormError message={getApiErrorMessage(recentQuery.error)} />
          ) : finished.length ? (
            <ul className="surface divide-y divide-border/60 overflow-hidden">
              {finished.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </ul>
          ) : (
            <p className="surface px-4 py-4 text-xs text-muted-foreground sm:px-5">
              No finished stocktakes yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
