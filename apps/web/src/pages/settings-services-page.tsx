import { RefreshCw, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { OnlineSearchSettingsCard } from "@/components/online-search-settings";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getApiErrorMessage } from "@/lib/api";
import { useAiStatus, useSession } from "@/lib/queries";
import type { AiStatus } from "@/lib/types";

type AiStatusBadge = {
  label: string;
  variant: "sage" | "brass" | "outline";
};

function summarizeAiStatus(status: AiStatus): AiStatusBadge {
  if (!status.configured) {
    const error = (status.error ?? "").toLowerCase();
    if (error.includes("disabled for this task")) {
      return { label: "Task disabled", variant: "outline" };
    }
    if (error.includes("consent")) {
      return { label: "Consent required", variant: "outline" };
    }
    if (error.includes("credential")) {
      return { label: "Credential unavailable", variant: "outline" };
    }
    if (error.includes("no longer exists")) {
      return { label: "Provider missing", variant: "outline" };
    }
    return { label: "Not configured", variant: "outline" };
  }
  if (!status.catalog_checked) {
    return { label: "Catalog check failed", variant: "brass" };
  }
  return status.available
    ? { label: "Model listed by provider", variant: "sage" }
    : { label: "Model not listed", variant: "brass" };
}

function processingLabel(mode: AiStatus["mode"]) {
  if (mode === "local") return "Local — on this server or its Docker host";
  if (mode === "private") return "Private network — leaves this server";
  if (mode === "cloud") return "Remote/cloud — leaves this server";
  return "Disabled";
}

function consentLabel(status: AiStatus) {
  if (status.mode === "disabled") return "Not applicable";
  if (status.mode === "local") return "Not required — stays local";
  return status.cloud_consent
    ? "Given for remote inference"
    : "Not given — remote inference blocked";
}


/** The AI summary and the online lookups of this household. */
export function SettingsServicesPage() {
  const session = useSession();
  const aiStatus = useAiStatus("assistant", { refetchOnMount: "always" });
  const isOwner = session.data?.role === "owner";

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="AI and online services"
        description="Optional services. The inventory, search and exports work without them."
        backTo="/settings"
        backLabel="Settings"
      />

      <div className="grid min-w-0 max-w-4xl gap-6">
        <section className="surface p-5 sm:p-6">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles className="size-4 shrink-0 text-brass" strokeWidth={1.7} />
              <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                Intelligence
              </h2>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={aiStatus.isFetching}
              onClick={() => void aiStatus.refetch()}
            >
              {aiStatus.isFetching ? <Spinner /> : <RefreshCw />}
              Check provider
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Optional local or cloud inference. Ordinary inventory, import, OCR and
            keyword search work without it.
          </p>
          {aiStatus.isPending ? (
            <Skeleton className="mt-4 h-24 rounded-xl" />
          ) : aiStatus.isError ? (
            <div className="mt-4">
              <FormError message={getApiErrorMessage(aiStatus.error)} />
            </div>
          ) : aiStatus.data ? (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    aiStatus.data.mode === "local"
                      ? "sage"
                      : aiStatus.data.mode === "private" || aiStatus.data.mode === "cloud"
                        ? "brass"
                        : "outline"
                  }
                >
                  {aiStatus.data.mode === "local"
                    ? "Local AI"
                    : aiStatus.data.mode === "private"
                      ? "Private-network AI"
                      : aiStatus.data.mode === "cloud"
                        ? "Remote AI"
                        : "AI disabled"}
                </Badge>
                <Badge variant={summarizeAiStatus(aiStatus.data).variant}>
                  {summarizeAiStatus(aiStatus.data).label}
                </Badge>
                {aiStatus.data.data_leaves_server && (
                  <Badge variant="brass">Data leaves this server</Badge>
                )}
              </div>
              <dl className="divide-y divide-border/60 rounded-xl border border-border/60">
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd className="min-w-0 break-all text-right">
                    {aiStatus.data.provider_label ??
                      (aiStatus.data.mode === "disabled"
                        ? "Not configured"
                        : aiStatus.data.provider)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
                  <dt className="text-muted-foreground">Selected model</dt>
                  <dd className="min-w-0 break-all text-right">
                    {aiStatus.data.model ?? "None"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
                  <dt className="text-muted-foreground">Processing</dt>
                  <dd className="min-w-0 break-all text-right">
                    {processingLabel(aiStatus.data.mode)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
                  <dt className="text-muted-foreground">Data consent</dt>
                  <dd className="min-w-0 break-all text-right">
                    {consentLabel(aiStatus.data)}
                  </dd>
                </div>
                {aiStatus.data.catalog_checked && (
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
                    <dt className="text-muted-foreground">Provider catalog</dt>
                    <dd className="min-w-0 text-right">
                      {aiStatus.data.catalog_count > 0
                        ? `${aiStatus.data.catalog_count} model${
                            aiStatus.data.catalog_count === 1 ? "" : "s"
                          } listed`
                        : "Empty"}
                    </dd>
                  </div>
                )}
              </dl>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {aiStatus.data.privacy_note}
              </p>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                This checks configuration only; Housetory does not send a test prompt.
              </p>
              {aiStatus.data.error && (
                <p className="rounded-lg border border-brass/20 bg-brass-soft/50 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {aiStatus.data.error}
                </p>
              )}
              {isOwner && (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/settings/ai">Manage AI providers</Link>
                </Button>
              )}
            </div>
          ) : null}
        </section>

        <OnlineSearchSettingsCard isOwner={isOwner} />
        {!isOwner && (
          <p className="text-2xs text-muted-foreground">
            Only the household owner can change AI providers and online lookups.
          </p>
        )}
      </div>
    </div>
  );
}
