import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useSystemStatus } from "@/lib/queries";
import type { AiTaskCompatibility, SystemStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function compatibilityBadge(value: AiTaskCompatibility) {
  if (value === "compatible") return { label: "Compatible", variant: "sage" as const };
  if (value === "unverified") return { label: "Unverified", variant: "brass" as const };
  if (value === "incompatible") {
    return { label: "Incompatible", variant: "destructive" as const };
  }
  if (value === "adapter_unavailable") {
    return { label: "Adapter unavailable", variant: "outline" as const };
  }
  return { label: "Not configured", variant: "outline" as const };
}

function readinessBadge(status: "ok" | "degraded" | "unknown") {
  if (status === "ok") return { label: "Ready", variant: "sage" as const };
  if (status === "degraded") {
    return { label: "Degraded", variant: "destructive" as const };
  }
  return { label: "Unknown", variant: "brass" as const };
}

function JobCounts({ status }: { status: SystemStatus }) {
  const entries = Object.entries(status.jobs.counts).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return <p className="text-[0.74rem] text-muted-foreground">No jobs recorded.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([name, count]) => (
        <Badge key={name} variant="outline" className="tabular-nums">
          {name}: {count}
        </Badge>
      ))}
    </div>
  );
}

export function SystemStatusPanel({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient();
  const statusQuery = useSystemStatus(isOwner);
  const retry = useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ id: string; task: string; status: string }>(
        `/system/jobs/${jobId}/retry`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
      toast.success("Job queued for retry");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  return (
    <section
      className="surface min-w-0 overflow-hidden p-5 sm:p-6"
      aria-labelledby="system-status-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="system-status-heading"
            className="flex items-center gap-2 font-display text-[1.35rem] font-normal tracking-[-0.02em]"
          >
            <Activity className="size-4 text-muted-foreground" strokeWidth={1.7} />
            System status
          </h2>
          <p className="mt-1 max-w-2xl text-[0.76rem] leading-relaxed text-muted-foreground">
            Release identity, local readiness, worker jobs and task readiness. This
            screen uses stored/runtime evidence and does not send paid prompts or expose
            keys or private content.
          </p>
        </div>
        {isOwner ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
          >
            {statusQuery.isFetching ? <Spinner /> : <RefreshCw />}
            Refresh
          </Button>
        ) : null}
      </div>

      {!isOwner ? (
        <p className="mt-4 rounded-xl border border-border/60 bg-background/35 px-3.5 py-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          Owner access is required for release identity, readiness, job errors and
          task-level status. Inventory, search and ordinary settings remain available
          to members and viewers.
        </p>
      ) : statusQuery.isPending ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : statusQuery.isError || !statusQuery.data ? (
        <p className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3.5 py-3 text-[0.74rem] leading-relaxed text-destructive">
          {getApiErrorMessage(statusQuery.error)}
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
              <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                <Server className="size-3.5" /> Release
              </p>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.72rem]">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="truncate">{statusQuery.data.release.version}</dd>
                <dt className="text-muted-foreground">Commit</dt>
                <dd className="truncate font-mono text-[0.68rem]">
                  {statusQuery.data.release.commit}
                </dd>
                <dt className="text-muted-foreground">Built</dt>
                <dd className="truncate">{statusQuery.data.release.build_time}</dd>
                <dt className="text-muted-foreground">Channel</dt>
                <dd className="truncate">{statusQuery.data.release.channel}</dd>
                <dt className="text-muted-foreground">Identity</dt>
                <dd className="truncate" title={statusQuery.data.release.identity}>
                  {statusQuery.data.release.identity}
                </dd>
              </dl>
            </div>

            <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
              <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                <Database className="size-3.5" /> Readiness
              </p>
              <ul className="mt-2 space-y-2">
                {statusQuery.data.readiness.map((component) => {
                  const badge = readinessBadge(component.status);
                  return (
                    <li
                      key={component.name}
                      className="flex items-start justify-between gap-2 text-[0.72rem]"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{component.name}</span>
                        {component.detail ? (
                          <span className="mt-0.5 block break-words text-[0.66rem] text-muted-foreground">
                            {component.detail}
                          </span>
                        ) : null}
                      </span>
                      <Badge variant={badge.variant} className="shrink-0">
                        {badge.label}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Worker jobs
              </p>
              <JobCounts status={statusQuery.data} />
            </div>
            {statusQuery.data.jobs.recent_failed.length === 0 ? (
              <p className="mt-2 text-[0.72rem] text-muted-foreground">
                No failed jobs recorded.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border/60">
                {statusQuery.data.jobs.recent_failed.map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-start justify-between gap-2 py-2 text-[0.72rem]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{job.task}</span>
                      <span className="ml-2 text-[0.66rem] text-muted-foreground">
                        {formatTimestamp(job.finished_at ?? job.created_at)}
                      </span>
                      {job.error ? (
                        <span className="mt-0.5 block break-words text-[0.66rem] text-muted-foreground">
                          {job.error}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(job.id)}
                    >
                      Retry
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
            <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              <ShieldCheck className="size-3.5" /> AI tasks
            </p>
            <ul className="mt-2 divide-y divide-border/60">
              {statusQuery.data.tasks.map((task) => {
                const compatibility = compatibilityBadge(task.compatibility);
                return (
                  <li key={task.task} className="py-2.5 text-[0.72rem]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{task.label}</span>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={task.configured ? "sage" : "outline"}>
                          {task.configured ? "Configured" : "Not configured"}
                        </Badge>
                        <Badge variant={compatibility.variant}>
                          {compatibility.label}
                        </Badge>
                        <Badge variant={task.live_tested ? "sage" : "outline"}>
                          {task.live_tested
                            ? `Live-tested ${formatTimestamp(task.last_test_at)}`
                            : task.last_test_status
                              ? `Test ${task.last_test_status}`
                              : "Not live-tested"}
                        </Badge>
                      </div>
                    </div>
                    <p className="mt-1 min-w-0 break-words text-[0.66rem] text-muted-foreground">
                      {task.provider_label ?? "No provider"}
                      {task.model
                        ? ` · ${task.model_label ?? task.model}`
                        : ""}
                      {task.model && !task.model_listed
                        ? " · saved ID not in catalog"
                        : ""}
                    </p>
                    {task.error ? (
                      <p className="mt-1 break-words text-[0.66rem] text-brass">
                        {task.error}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
            <p className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Optional external services
            </p>
            <ul className="mt-2 space-y-2">
              {statusQuery.data.external_services.map((service) => (
                <li
                  key={service.name}
                  className="flex flex-wrap items-start justify-between gap-2 text-[0.72rem]"
                >
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-medium">{service.name}</span>
                    <span className="mt-0.5 block break-words text-[0.66rem] text-muted-foreground">
                      {service.detail}
                    </span>
                  </span>
                  <Badge
                    variant={
                      service.status === "configured"
                        ? "sage"
                        : service.status === "partial"
                          ? "brass"
                          : "outline"
                    }
                    className={cn("shrink-0")}
                  >
                    {service.status.replace("_", " ")}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-[0.66rem] text-muted-foreground">
            Last generated {formatTimestamp(statusQuery.data.generated_at)}. Discovery
            and catalog checks are not live inference tests; use Test on a task for a
            bounded, explicitly confirmed live request.
          </p>
        </div>
      )}
    </section>
  );
}
