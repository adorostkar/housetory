import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { SystemHealthSummary } from "@/components/system-health-summary";
import { SystemStatusPanel } from "@/components/system-status-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useScrollToHash } from "@/hooks/use-scroll-to-hash";
import { useSession } from "@/lib/queries";

export function SystemStatusPage() {
  const session = useSession();
  const isOwner = session.data?.role === "owner";
  useScrollToHash(!session.isPending);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="System status"
        description="Owner-only release identity, readiness, worker jobs, AI task test results and optional-service diagnostics. Refresh is passive and does not call external providers."
        backTo="/settings"
        backLabel="Back to Settings"
      />
      {session.isPending ? (
        <div className="surface space-y-3 p-5 sm:p-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : !isOwner ? (
        <section className="surface mx-auto max-w-lg p-8 text-center">
          <ShieldCheck className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 font-display text-2xl tracking-[-0.03em]">
            Owner only.
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Only the household owner can view release identity, readiness, worker
            jobs and task diagnostics.
          </p>
          <Button variant="outline" className="mt-5" asChild>
            <Link to="/settings">Back to Settings</Link>
          </Button>
        </section>
      ) : (
        <div className="grid min-w-0 gap-5">
          <SystemHealthSummary isOwner detailsLink={false} />
          <SystemStatusPanel isOwner title="Detailed status" />
        </div>
      )}
    </div>
  );
}
