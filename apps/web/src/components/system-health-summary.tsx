import { Activity, AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiErrorMessage } from "@/lib/api";
import { useSystemStatusSummary } from "@/lib/queries";

function timestamp(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SystemHealthSummary({ isOwner }: { isOwner: boolean }) {
  const statusQuery = useSystemStatusSummary(isOwner);

  if (!isOwner) {
    return (
      <section id="system-status" className="surface p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-display text-[1.35rem] tracking-[-0.02em]">
          <Activity className="size-4 text-muted-foreground" />
          System health
        </h2>
        <p className="mt-2 text-[0.76rem] leading-relaxed text-muted-foreground">
          Owner access is required for readiness, worker jobs and system
          diagnostics.
        </p>
      </section>
    );
  }

  const data = statusQuery.data;
  const attention = data?.status === "attention";
  const coreProblems = data?.core_issue_count ?? 0;
  const badgeVariant = !attention
    ? ("sage" as const)
    : coreProblems > 0
      ? ("destructive" as const)
      : ("brass" as const);

  return (
    <section
      id="system-status"
      className="surface p-5 sm:p-6"
      aria-labelledby="system-health-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="system-health-heading"
            className="flex items-center gap-2 font-display text-[1.35rem] tracking-[-0.02em]"
          >
            <Activity className="size-4 text-muted-foreground" />
            System health
          </h2>
          <p className="mt-1 max-w-2xl text-[0.76rem] leading-relaxed text-muted-foreground">
            A compact summary of core readiness, worker jobs and configured
            features. Optional services that are not configured do not count as
            outages.
          </p>
        </div>
        {statusQuery.isPending ? (
          <Skeleton className="h-6 w-24 rounded-full" />
        ) : (
          <Badge variant={badgeVariant}>
            {attention
              ? `${data?.attention_count ?? 0} need attention`
              : "Healthy"}
          </Badge>
        )}
      </div>

      {statusQuery.isPending ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : statusQuery.isError || !data ? (
        <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3.5 py-3 text-[0.74rem] leading-relaxed text-destructive">
          <p className="font-medium">System health is unavailable.</p>
          <p className="mt-1">{getApiErrorMessage(statusQuery.error)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/settings/system-status">Open System status</Link>
            </Button>
          </div>
        </div>
      ) : data.status === "healthy" ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-sage/20 bg-sage-soft/30 px-3.5 py-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-sage" />
          <div>
            <p className="font-medium text-foreground/85">
              Core readiness, worker jobs and configured features are healthy.
            </p>
            {data.optional_not_configured.length > 0 ? (
              <p className="mt-1">
                Optional, not configured: {data.optional_not_configured.join(", ")}.
                These are not core outages.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/30 px-3.5 py-3 text-[0.74rem] leading-relaxed text-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass" />
            <div className="min-w-0">
              <p className="font-medium text-foreground/85">
                {data.attention_count} status item
                {data.attention_count === 1 ? "" : "s"} need attention.
              </p>
              <p className="mt-1">
                {data.core_issue_count > 0
                  ? `${data.core_issue_count} core health issue${
                      data.core_issue_count === 1 ? "" : "s"
                    }. `
                  : ""}
                {data.configured_feature_issue_count > 0
                  ? `${data.configured_feature_issue_count} configured feature issue${
                      data.configured_feature_issue_count === 1 ? "" : "s"
                    }.`
                  : ""}
              </p>
              <ul className="mt-2 space-y-1">
                {data.issues.slice(0, 3).map((issue) => (
                  <li key={`${issue.kind}-${issue.label}`}>
                    <span className="font-medium text-foreground/80">
                      {issue.label}:
                    </span>{" "}
                    {issue.detail}
                  </li>
                ))}
              </ul>
              {data.issues.length > 3 ? (
                <p className="mt-1">
                  and {data.issues.length - 3} more in System status.
                </p>
              ) : null}
              {data.optional_not_configured.length > 0 ? (
                <p className="mt-1">
                  Optional, not configured:{" "}
                  {data.optional_not_configured.join(", ")}. These are not core
                  outages.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.66rem] text-muted-foreground">
          {data?.generated_at
            ? `Checked ${timestamp(data.generated_at)}.`
            : "This is a passive status check and does not call external providers."}
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/settings/system-status">
            Open System status
            <ArrowRight />
          </Link>
        </Button>
      </div>
    </section>
  );
}
