import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { PageHeader } from "@/components/page-header";
import { PropertiesSettings } from "@/components/properties-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useScrollToHash } from "@/hooks/use-scroll-to-hash";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { CURRENCIES } from "@/lib/labels";
import { queryKeys, useSession } from "@/lib/queries";
import type { Household, OfflineCopyPolicy, SessionState } from "@/lib/types";

const OFFLINE_POLICIES: Array<{ value: OfflineCopyPolicy; label: string }> = [
  { value: "members", label: "Owners and members" },
  { value: "everyone", label: "Everyone, also viewers" },
  { value: "nobody", label: "Nobody" },
];

/** Household name and defaults, item images, homes and the household switcher. */
export function SettingsHouseholdPage() {
  const session = useSession();
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

  const [offlinePolicy, setOfflinePolicy] = React.useState<OfflineCopyPolicy>(
    session.data?.household?.offline_copy_policy ?? "members",
  );

  React.useEffect(() => {
    if (session.data?.household) {
      setOfflinePolicy(session.data.household.offline_copy_policy ?? "members");
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
        offline_copy_policy: offlinePolicy,
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

  useScrollToHash(!session.isPending);

  if (session.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-12 w-48" />
        <Skeleton className="mt-10 h-80 rounded-2xl" />
      </div>
    );
  }

  const household = session.data?.household;
  const isOwner = session.data?.role === "owner";
  const fieldErrors =
    saveHousehold.error instanceof ApiError ? saveHousehold.error.fields : undefined;
  const generalError =
    saveHousehold.error && !fieldErrors
      ? getApiErrorMessage(saveHousehold.error)
      : null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="Household"
        description="Name, defaults, item images and homes for the household you are in now."
        backTo="/settings"
        backLabel="Settings"
      />

      <div className="grid min-w-0 max-w-4xl gap-6">
        <section className="surface p-5 sm:p-6">
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            Household details
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
              className="min-h-11"
              disabled={
                !isOwner ||
                saveHousehold.isPending ||
                !householdName.trim() ||
                reminderInvalid ||
                (householdName.trim() === household?.name &&
                  defaultCurrency === (household?.default_currency ?? "USD") &&
                  Number(reminderDays) === household?.warranty_reminder_days &&
                  autoReference === (household?.item_image_auto_reference ?? false) &&
                  offlinePolicy === (household?.offline_copy_policy ?? "members"))
              }
            >
              {saveHousehold.isPending && <Spinner />}
              Save
            </Button>
          </form>
          <div
            id="item-images"
            className="mt-5 scroll-mt-24 rounded-xl border border-border/60 bg-background/35 p-3.5"
          >
            <p className="text-xs font-medium">Item images</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Item pages show your photo first, then a reference image, then a category icon.
            </p>
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
                  Off by default. Needs online search to be set up under AI and online services.
                </span>
              </span>
            </label>
          </div>
          <div
            id="offline-copies"
            className="mt-3 scroll-mt-24 rounded-xl border border-border/60 bg-background/35 p-3.5"
          >
            <label htmlFor="offline-copy-policy" className="text-xs font-medium">
              Offline copies
            </label>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Who may keep a read-only copy of this household on a phone, tablet or computer.
              Each person turns it on for their own device. A copy that is no longer allowed is
              removed when that device next reaches the server. Save to apply.
            </p>
            <Select
              id="offline-copy-policy"
              className="mt-3 max-w-xs"
              value={offlinePolicy}
              disabled={!isOwner || saveHousehold.isPending}
              onChange={(event) => setOfflinePolicy(event.target.value as OfflineCopyPolicy)}
            >
              {OFFLINE_POLICIES.map((policy) => (
                <option key={policy.value} value={policy.value}>
                  {policy.label}
                </option>
              ))}
            </Select>
          </div>
          {generalError && <div className="mt-3"><FormError message={generalError} /></div>}
          <div className="max-w-sm">
            <HouseholdSwitcher />
          </div>
          {isOwner ? (
            <Button variant="outline" size="sm" className="mt-4 min-h-11" asChild>
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
      </div>
    </div>
  );
}
