import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, RefreshCw, Smartphone, Sparkles, Users } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { OnlineSearchSettingsCard } from "@/components/online-search-settings";
import { PropertiesSettings } from "@/components/properties-settings";
import { SystemHealthSummary } from "@/components/system-health-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { CURRENCIES } from "@/lib/labels";
import {
  queryKeys,
  useAiStatus,
  useLogout,
  useOverview,
  useSession,
} from "@/lib/queries";
import type { AiStatus, Household, SessionState } from "@/lib/types";
import { formatFileSize } from "@/lib/utils";

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

export function SettingsPage() {
  const session = useSession();
  const overview = useOverview();
  const aiStatus = useAiStatus("assistant", { refetchOnMount: "always" });
  const logout = useLogout();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [householdName, setHouseholdName] = React.useState(session.data?.household?.name ?? "");
  const [defaultCurrency, setDefaultCurrency] = React.useState(
    session.data?.household?.default_currency ?? "USD",
  );
  const [reminderDays, setReminderDays] = React.useState(
    String(session.data?.household?.warranty_reminder_days ?? 30),
  );
  const [autoReference, setAutoReference] = React.useState(
    session.data?.household?.item_image_auto_reference ?? false,
  );

  React.useEffect(() => {
    if (session.data?.household) {
      setHouseholdName(session.data.household.name);
      setDefaultCurrency(session.data.household.default_currency ?? "USD");
      setReminderDays(String(session.data.household.warranty_reminder_days));
      setAutoReference(session.data.household.item_image_auto_reference ?? false);
    }
  }, [session.data?.household]);

  const reminderInvalid =
    !/^\d+$/.test(reminderDays) ||
    Number(reminderDays) < 1 ||
    Number(reminderDays) > 3650;

  const saveHousehold = useMutation({
    mutationFn: () =>
      api.patch<Household>("/household", {
        name: householdName.trim(),
        default_currency: defaultCurrency,
        warranty_reminder_days: Number(reminderDays),
        item_image_auto_reference: autoReference,
      }),
    onSuccess: (household) => {
      queryClient.setQueryData<SessionState>(queryKeys.session, (current) =>
        current
          ? {
              ...current,
              household,
              households: current.households?.map((entry) =>
                entry.id === household.id ? { ...entry, ...household } : entry,
              ),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.warranties });
      toast.success("Household settings updated");
    },
  });

  if (session.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-12 w-48" />
        <Skeleton className="mt-10 h-80 rounded-2xl" />
      </div>
    );
  }

  const user = session.data?.user;
  const household = session.data?.household;
  const isOwner = session.data?.role === "owner";
  const fieldErrors =
    saveHousehold.error instanceof ApiError ? saveHousehold.error.fields : undefined;
  const generalError =
    saveHousehold.error && !fieldErrors
      ? getApiErrorMessage(saveHousehold.error)
      : null;
  const storageBytes = (overview.data?.photo_bytes ?? 0) + (overview.data?.document_bytes ?? 0);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Your account, household and the way Housetory looks."
      />

      <div className="grid min-w-0 max-w-4xl gap-6">
        <section className="surface p-5 sm:p-6">
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            Household
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This is the current editable household. Your account can belong to
            several households with a different role in each; search and the
            assistant default to all your current places.
          </p>
          <form
            className="mt-5 grid max-w-2xl gap-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (householdName.trim() && !reminderInvalid) {
                saveHousehold.mutate();
              }
            }}
          >
            <Field
              label="Household name"
              htmlFor="household-name"
              error={fieldErrors?.name}
            >
              <Input
                id="household-name"
                value={householdName}
                maxLength={120}
                disabled={!isOwner || saveHousehold.isPending}
                onChange={(event) => setHouseholdName(event.target.value)}
              />
            </Field>
            <Field
              label="Warranty reminder"
              htmlFor="warranty-reminder-days"
              hint="Days before expiry"
              error={reminderInvalid ? "Enter 1–3,650 days." : undefined}
            >
              <Input
                id="warranty-reminder-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                step={1}
                value={reminderDays}
                disabled={!isOwner || saveHousehold.isPending}
                onChange={(event) => setReminderDays(event.target.value)}
              />
            </Field>
            <Field
              label="Default currency"
              htmlFor="default-currency"
              hint="Starting choice for new entries"
              error={fieldErrors?.default_currency}
            >
              <Select
                id="default-currency"
                value={defaultCurrency}
                disabled={!isOwner || saveHousehold.isPending}
                onChange={(event) => setDefaultCurrency(event.target.value)}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={
                !isOwner ||
                saveHousehold.isPending ||
                !householdName.trim() ||
                reminderInvalid ||
                (householdName.trim() === household?.name &&
                  defaultCurrency === (household?.default_currency ?? "USD") &&
                  Number(reminderDays) === household?.warranty_reminder_days &&
                  autoReference === (household?.item_image_auto_reference ?? false))
              }
            >
              {saveHousehold.isPending && <Spinner />}
              Save
            </Button>
          </form>
          <div
            id="item-images"
            className="mt-5 rounded-xl border border-border/60 bg-background/35 p-3.5"
          >
            <p className="text-xs font-medium">Item images</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Item pages use actual photos first, then a public reference image, then a
              category icon. Existing AI illustrations remain viewable and removable;
              new illustration generation was retired.
            </p>
            <div className="mt-3 rounded-lg border border-border/60 bg-background/30 p-3">
              <p className="text-2xs font-medium">Online reference-image lookup</p>
              <p className="mt-1 break-words text-2xs leading-relaxed text-muted-foreground">
                Configure it in{" "}
                <Link
                  to="/settings#online-search"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Online search
                </Link>
                : add one Brave Search key. Reference-image lookup searches public
                websites automatically by default; an optional advanced source
                restriction can narrow downloads.
              </p>
            </div>
            <label className="mt-3 flex items-start gap-2.5 text-2xs">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-border"
                checked={autoReference}
                disabled={!isOwner || saveHousehold.isPending}
                onChange={(event) => setAutoReference(event.target.checked)}
              />
              <span>
                Automatically find a reference image for new items
                <span className="mt-0.5 block text-2xs text-muted-foreground">
                  Off by default. Requires a configured Brave Image Search key and a
                  saved item with a useful product description.
                </span>
              </span>
            </label>
          </div>
          {generalError && <div className="mt-3"><FormError message={generalError} /></div>}
          <div className="max-w-sm">
            <HouseholdSwitcher />
          </div>
          {isOwner ? (
            <Button variant="outline" size="sm" className="mt-4" asChild>
              <Link to="/settings/members">
                <Users />
                Members & invitations
              </Link>
            </Button>
          ) : (
            <p className="mt-2 text-2xs text-muted-foreground">
              Only the household owner can change these settings or manage members.
            </p>
          )}
        </section>

        <PropertiesSettings />

        <section className="surface p-5 sm:p-6">
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            Account
          </h2>
          <dl className="mt-5 divide-y divide-border/60">
            <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
              <dt className="text-xs text-muted-foreground">Name</dt>
              <dd className="text-sm">{user?.name}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-xs text-muted-foreground">Email</dt>
              <dd className="break-all text-right text-sm">{user?.email}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
              <dt className="text-xs text-muted-foreground">Role</dt>
              <dd>
                <Badge variant="outline" className="capitalize">
                  {session.data?.role}
                </Badge>
              </dd>
            </div>
          </dl>
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link to="/settings/account">Account settings</Link>
          </Button>
        </section>

        <section className="surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                Storage
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Photographs and documents live on your server's persistent volume.
              </p>
            </div>
            <p className="shrink-0 text-sm tabular-nums text-foreground/80">
              {formatFileSize(storageBytes)}
            </p>
          </div>
          <p className="mt-4 text-2xs text-muted-foreground">
            Back up your database and uploads regularly with{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-2xs">scripts/backup.sh</code>.
          </p>
        </section>

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
                Status checks provider configuration and, when configured, the
                provider&apos;s model catalog. A listed model is not proof of inference
                access, billing eligibility or output quality; Housetory does not send a
                test prompt. Choose or search models on the AI providers page.
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

        <SystemHealthSummary isOwner={isOwner} />

        <section className="surface p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              On your iPhone
            </h2>
          </div>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Open Housetory at its trusted HTTPS address — your public domain, a
            trusted LAN address, or an optional Tailscale address — in Safari, tap
            the Share button, then choose{" "}
            <span className="text-foreground">Add to Home Screen</span>. Camera
            capture and installed-PWA features require this secure context.
          </p>
        </section>

        <section className="surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              Sign out
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              End this session on this device.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => {
                  toast.success("Signed out");
                  navigate("/login", { replace: true });
                },
                onError: (error) => toast.error(getApiErrorMessage(error)),
              })
            }
          >
            <LogOut />
            Sign out
          </Button>
        </section>
      </div>
    </div>
  );
}
