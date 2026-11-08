import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarClock,
  Check,
  Database,
  Minus,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useSystemStatus } from "@/lib/queries";
import type {
  AiTaskCompatibility,
  AiTaskTestResult,
  SystemStatus,
  SystemTaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type BulkTestState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "unsupported"
  | "skipped";

interface BulkTestProgress {
  state: BulkTestState;
  message?: string;
}

interface TaskTestPlanEntry {
  task: SystemTaskStatus;
  state: "queued" | "skipped";
  reason?: string;
}

const BULK_TASK_TIMEOUT_MS = 120_000;
const BULK_TIMEOUT_MESSAGE =
  "No response before the 120-second client timeout. The provider may still be processing; refresh status before retrying.";

export function buildTaskTestPlan(tasks: SystemTaskStatus[]): TaskTestPlanEntry[] {
  return tasks.map((task) => {
    if (!task.enabled) {
      return {
        task,
        state: "skipped" as const,
        reason: "Disabled for this household.",
      };
    }
    if (!task.configured) {
      return {
        task,
        state: "skipped" as const,
        reason: task.error || "No provider/model is currently configured.",
      };
    }
    return { task, state: "queued" as const };
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(BULK_TIMEOUT_MESSAGE)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function bulkStateBadge(state: BulkTestState) {
  if (state === "passed") {
    return {
      label: "Passed",
      variant: "sage" as const,
      icon: Check,
    };
  }
  if (state === "failed") {
    return {
      label: "Failed",
      variant: "destructive" as const,
      icon: X,
    };
  }
  if (state === "unsupported") {
    return {
      label: "Unsupported",
      variant: "brass" as const,
      icon: Minus,
    };
  }
  if (state === "skipped") {
    return {
      label: "Skipped",
      variant: "outline" as const,
      icon: Minus,
    };
  }
  if (state === "running") {
    return {
      label: "Running…",
      variant: "brass" as const,
      icon: Play,
    };
  }
  return {
    label: "Queued",
    variant: "outline" as const,
    icon: Play,
  };
}

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

function BulkTestStatus({ entry }: { entry: BulkTestProgress }) {
  const badge = bulkStateBadge(entry.state);
  const Icon = badge.icon;
  return (
    <div className="mt-1 flex flex-wrap items-start gap-1.5 text-[0.64rem] leading-relaxed">
      <Badge variant={badge.variant} className="shrink-0">
        <Icon className="size-3" />
        {badge.label}
      </Badge>
      {entry.message ? (
        <span className="min-w-0 break-words text-muted-foreground">
          {entry.message}
        </span>
      ) : null}
    </div>
  );
}

export function SystemStatusPanel({
  isOwner,
  title = "System status",
}: {
  isOwner: boolean;
  title?: string;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useSystemStatus(isOwner);
  const retry = useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ id: string; task: string; status: string }>(
        `/system/jobs/${jobId}/retry`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.systemStatusSummary,
      });
      toast.success("Job queued for retry");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });
  const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);
  const [bulkPlan, setBulkPlan] = React.useState<TaskTestPlanEntry[] | null>(null);
  const [bulkResults, setBulkResults] = React.useState<
    Record<string, BulkTestProgress>
  >({});
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const bulkRunRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const availableTestCount = statusQuery.data
    ? buildTaskTestPlan(statusQuery.data.tasks).filter(
        (entry) => entry.state === "queued",
      ).length
    : 0;
  const requestedTestCount =
    bulkPlan?.filter((entry) => entry.state === "queued").length ?? 0;
  const requestedTaskLabels =
    bulkPlan
      ?.filter((entry) => entry.state === "queued")
      .map((entry) => entry.task.label) ?? [];
  const bulkEntries = Object.values(bulkResults);
  const bulkLiveEntries = bulkEntries.filter((entry) => entry.state !== "skipped");
  const bulkFinished = bulkLiveEntries.filter(
    (entry) =>
      entry.state === "passed" ||
      entry.state === "failed" ||
      entry.state === "unsupported",
  ).length;

  const openBulkTest = () => {
    const tasks = statusQuery.data?.tasks ?? [];
    const plan = buildTaskTestPlan(tasks);
    if (!plan.some((entry) => entry.state === "queued")) return;
    setBulkPlan(plan);
    setBulkResults({});
    setBulkConfirmOpen(true);
  };

  const runBulkTest = async (plan: TaskTestPlanEntry[]) => {
    if (bulkRunRef.current) return;
    bulkRunRef.current = true;
    setBulkRunning(true);
    const initial: Record<string, BulkTestProgress> = {};
    for (const entry of plan) {
      initial[entry.task.task] =
        entry.state === "skipped"
          ? { state: "skipped", message: entry.reason }
          : { state: "queued" };
    }
    setBulkResults(initial);

    let passed = 0;
    let failed = 0;
    let unsupported = 0;
    try {
      for (const entry of plan) {
        if (entry.state === "skipped" || !mountedRef.current) continue;
        setBulkResults((current) => ({
          ...current,
          [entry.task.task]: { state: "running" },
        }));
        try {
          const result = await withTimeout(
            api.post<AiTaskTestResult>(`/ai/tasks/${entry.task.task}/test`, {
              confirm: true,
            }),
            BULK_TASK_TIMEOUT_MS,
          );
          if (!mountedRef.current) break;
          setBulkResults((current) => ({
            ...current,
            [entry.task.task]: {
              state: result.status,
              message: result.message,
            },
          }));
          if (result.status === "passed") passed += 1;
          else if (result.status === "failed") failed += 1;
          else unsupported += 1;
        } catch (error) {
          if (!mountedRef.current) break;
          setBulkResults((current) => ({
            ...current,
            [entry.task.task]: {
              state: "failed",
              message: getApiErrorMessage(error),
            },
          }));
          failed += 1;
        }
      }
    } finally {
      bulkRunRef.current = false;
      if (mountedRef.current) {
        setBulkRunning(false);
        await queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.systemStatusSummary,
        });
        const skipped = plan.filter((entry) => entry.state === "skipped").length;
        const summary = `${passed} passed, ${failed} failed, ${unsupported} unsupported, ${skipped} skipped.`;
        if (failed || unsupported) {
          toast.error(`AI task tests finished: ${summary}`);
        } else {
          toast.success(`AI task tests finished: ${summary}`);
        }
      }
    }
  };

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
            {title}
          </h2>
          <p className="mt-1 max-w-2xl text-[0.76rem] leading-relaxed text-muted-foreground">
            Release identity, local readiness, worker jobs and task readiness.{" "}
            <span className="text-foreground/80">Reload status snapshot</span> only
            reads stored and runtime evidence and never calls a provider.{" "}
            <span className="text-foreground/80">Test all enabled AI tasks</span> is a
            separate, explicitly confirmed live action that may incur provider usage or
            cost.
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
            Reload status snapshot
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
              <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                <CalendarClock className="size-3.5" /> Scheduled review
              </p>
              <Badge
                variant={
                  statusQuery.data.scheduled_review.state === "scheduled"
                    ? "sage"
                    : statusQuery.data.scheduled_review.state === "attention"
                      ? "destructive"
                      : statusQuery.data.scheduled_review.state === "consent_needed" ||
                          statusQuery.data.scheduled_review.state ===
                            "ai_not_configured"
                        ? "brass"
                        : "outline"
                }
              >
                {statusQuery.data.scheduled_review.state.replaceAll("_", " ")}
              </Badge>
            </div>
            <p className="mt-2 text-[0.72rem] leading-relaxed text-muted-foreground">
              {statusQuery.data.scheduled_review.state_detail}
            </p>
            <p className="mt-1 text-[0.68rem] text-muted-foreground">
              {statusQuery.data.scheduled_review.scope_label} ·{" "}
              {statusQuery.data.scheduled_review.frequency} ·{" "}
              {statusQuery.data.scheduled_review.timezone}
              {statusQuery.data.scheduled_review.include_ai
                ? ` · AI ${
                    statusQuery.data.scheduled_review.ai_consent_valid
                      ? "consented"
                      : "consent needed"
                  }`
                : " · offline rules only"}
            </p>
            <p className="mt-1 text-[0.68rem] text-muted-foreground">
              Last run:{" "}
              {statusQuery.data.scheduled_review.last_run_status === "never"
                ? "never"
                : `${statusQuery.data.scheduled_review.last_run_status} · ${formatTimestamp(
                    statusQuery.data.scheduled_review.last_run_at,
                  )}`}
              {" · "}Next due:{" "}
              {formatTimestamp(statusQuery.data.scheduled_review.next_due_at)}
            </p>
            {statusQuery.data.scheduled_review.last_run_detail ? (
              <p className="mt-1 break-words text-[0.68rem] text-muted-foreground">
                {statusQuery.data.scheduled_review.last_run_detail}
              </p>
            ) : null}
            <p className="mt-1 text-[0.64rem] text-muted-foreground">
              Hard caps: {statusQuery.data.scheduled_review.max_items} items per run,{" "}
              {statusQuery.data.scheduled_review.provider_request_cap} AI provider
              request per run.
            </p>
            <Link
              to="/review"
              className="mt-1 inline-block text-[0.66rem] text-brass underline-offset-2 hover:underline"
            >
              Open Review schedule
            </Link>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                <ShieldCheck className="size-3.5" /> AI tasks
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {bulkRunning || bulkEntries.length > 0 ? (
                  <span
                    className="text-[0.64rem] tabular-nums text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    {bulkRunning
                      ? `Testing ${bulkFinished} of ${bulkLiveEntries.length} live tasks…`
                      : `${bulkFinished} of ${bulkLiveEntries.length} live tasks finished`}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={bulkRunning || availableTestCount === 0}
                  title={
                    availableTestCount === 0
                      ? "No enabled and configured AI tasks are available to test."
                      : "Run one confirmed, minimal synthetic live test per enabled and configured AI task."
                  }
                  onClick={openBulkTest}
                >
                  {bulkRunning ? <Spinner /> : <Play />}
                  {bulkRunning ? "Testing AI tasks…" : "Test all enabled AI tasks"}
                </Button>
              </div>
            </div>
            <ul className="mt-2 divide-y divide-border/60">
              {statusQuery.data.tasks.map((task) => {
                const compatibility = compatibilityBadge(task.compatibility);
                const bulkEntry = bulkResults[task.task];
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
                    {bulkEntry ? <BulkTestStatus entry={bulkEntry} /> : null}
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
                    {service.source && service.source !== "unknown" ? (
                      <span className="mt-1 block text-[0.62rem] uppercase tracking-[0.08em] text-muted-foreground">
                        Source:{" "}
                        {service.source === "household"
                          ? "Household settings"
                          : service.source === "environment"
                            ? "Installation fallback"
                            : "Not configured"}
                      </span>
                    ) : null}
                    {service.settings_path ? (
                      <Link
                        to={service.settings_path}
                        className="mt-1 inline-block text-[0.66rem] text-brass underline-offset-2 hover:underline"
                      >
                        Open settings
                      </Link>
                    ) : null}
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
            and catalog checks are not live inference tests. Individual Test buttons and
            Test all enabled AI tasks runs bounded, explicitly confirmed live requests.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          setBulkConfirmOpen(open);
          if (!open) setBulkPlan(null);
        }}
        title="Run live tests for enabled AI tasks?"
        description={
          bulkPlan
            ? `This runs ${requestedTestCount} sequential, minimal synthetic probe${
                requestedTestCount === 1 ? "" : "s"
              } using each task's currently selected provider and model: ${requestedTaskLabels.join(
                ", ",
              )}. It makes external provider calls and may incur usage or credits. It sends no inventory, photos, real documents, audio recordings, borrower data or notes. Transcription tests use a synthetic tone; vision tests use a synthetic image. Disabled or unconfigured tasks are skipped with a reason. A client disconnect does not cancel an in-flight provider request; refresh status afterwards to see stored results.`
            : ""
        }
        confirmLabel={`Run ${requestedTestCount} task test${
          requestedTestCount === 1 ? "" : "s"
        }`}
        onConfirm={async () => {
          const plan = bulkPlan;
          setBulkPlan(null);
          if (plan) void runBulkTest(plan);
        }}
      />
    </section>
  );
}
