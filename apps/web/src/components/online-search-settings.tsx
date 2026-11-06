import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Globe2,
  KeyRound,
  Trash2,
  Wifi,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useOnlineSearchSettings,
} from "@/lib/queries";
import type {
  OnlineSearchSettings,
  OnlineSearchSource,
  OnlineSearchTestResult,
} from "@/lib/types";

function sourceLabel(source: OnlineSearchSource) {
  if (source === "household") return "Household settings";
  if (source === "environment") return "Installation fallback";
  return "Not configured";
}

function sourceVariant(source: OnlineSearchSource) {
  return source === "household"
    ? ("sage" as const)
    : source === "environment"
      ? ("brass" as const)
      : ("outline" as const);
}

function domainList(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function OnlineSearchSettingsCard({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient();
  const settingsQuery = useOnlineSearchSettings(isOwner);
  const settings = settingsQuery.data;
  const [apiKey, setApiKey] = React.useState("");
  const [manualEnabled, setManualEnabled] = React.useState(false);
  const [referenceEnabled, setReferenceEnabled] = React.useState(false);
  const [domainsText, setDomainsText] = React.useState("");
  const [testConfirmOpen, setTestConfirmOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [testResult, setTestResult] = React.useState<OnlineSearchTestResult | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!settings) return;
    setManualEnabled(settings.manual_enabled);
    setReferenceEnabled(settings.reference_enabled);
    setDomainsText(settings.permitted_source_domains.join("\n"));
  }, [
    settings?.updated_at,
    settings?.has_api_key,
    settings?.api_key_version,
    settings?.manual_enabled,
    settings?.reference_enabled,
    settings?.permitted_source_domains,
  ]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.onlineSearchSettings });
    void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    void queryClient.invalidateQueries({ queryKey: ["items"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const domains = domainList(domainsText);
      return api.put<OnlineSearchSettings>("/settings/online-search", {
        manual_enabled: manualEnabled,
        reference_enabled: referenceEnabled,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        permitted_source_domains: domains,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.onlineSearchSettings, updated);
      setApiKey("");
      setFormError(null);
      refresh();
      toast.success("Online search settings saved");
    },
    onError: (error) => setFormError(getApiErrorMessage(error)),
  });

  const removeKey = useMutation({
    mutationFn: () =>
      api.put<OnlineSearchSettings>("/settings/online-search", {
        manual_enabled: false,
        reference_enabled: false,
        clear_api_key: true,
        permitted_source_domains: domainList(domainsText),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.onlineSearchSettings, updated);
      setManualEnabled(false);
      setReferenceEnabled(false);
      setApiKey("");
      setFormError(null);
      refresh();
      toast.success("Brave Search key removed");
    },
    onError: (error) => setFormError(getApiErrorMessage(error)),
  });

  const testConnection = useMutation({
    mutationFn: () =>
      api.post<OnlineSearchTestResult>("/settings/online-search/test", {
        confirm: true,
      }),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (!isOwner) return null;

  if (settingsQuery.isPending) {
    return (
      <section id="online-search" className="surface p-5 sm:p-6">
        <p className="text-[0.78rem] text-muted-foreground">Loading online search settings…</p>
      </section>
    );
  }
  if (settingsQuery.isError || !settings) {
    return (
      <section id="online-search" className="surface p-5 sm:p-6">
        <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Online search</h2>
        <FormError message={getApiErrorMessage(settingsQuery.error)} />
      </section>
    );
  }

  const domains = domainList(domainsText);
  const hasKeyAfterSave = settings.has_api_key || Boolean(apiKey.trim());
  const keyMissing =
    (manualEnabled || referenceEnabled) && !hasKeyAfterSave;
  const domainsMissing = referenceEnabled && domains.length === 0;
  const saveDisabled =
    save.isPending ||
    keyMissing ||
    domainsMissing ||
    (Boolean(apiKey.trim()) && !settings.credential_storage_ready);

  return (
    <section
      id="online-search"
      className="surface p-5 sm:p-6"
      aria-labelledby="online-search-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="online-search-heading"
            className="flex items-center gap-2 font-display text-[1.35rem] tracking-[-0.02em]"
          >
            <Globe2 className="size-4 text-brass" />
            Online search
          </h2>
          <p className="mt-1 max-w-2xl text-[0.78rem] leading-relaxed text-muted-foreground">
            One Brave Search API credential can power online manual discovery and
            reference-image lookup. The key is encrypted at rest, write-only from this
            screen and never returned to the browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="brass">Brave</Badge>
          <Badge variant={sourceVariant(settings.credential_source)}>
            {sourceLabel(settings.credential_source)}
          </Badge>
        </div>
      </div>

      {settings.warning && (
        <p className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/40 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
          {settings.warning}
        </p>
      )}

      {settings.credential_source === "environment" && (
        <div className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/30 px-3.5 py-3 text-[0.72rem] leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground/85">Installation fallback is active.</p>
          <p className="mt-1">
            This household has no saved online-search settings, so the server
            environment fallback is being used. Saving this card overrides the
            fallback for this household; saving with both controls off suppresses it.
          </p>
        </div>
      )}

      {settings.credential_source === "household" &&
        !settings.has_api_key &&
        settings.environment_api_key_available && (
          <div className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/30 px-3.5 py-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            Household settings are authoritative. The installation fallback key is
            ignored while this household configuration exists.
          </div>
        )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border/65 bg-background/35 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[0.86rem] font-medium">Online manual search</h3>
            <Badge variant={settings.manual.configured ? "sage" : "outline"}>
              {settings.manual.configured ? "Ready" : "Not configured"}
            </Badge>
          </div>
          <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
            Find exact manufacturer/model manuals from online sources. Manual uploads
            and attached-manual questions continue to work without it.
          </p>
          <label className="mt-3 flex items-start gap-2.5 text-[0.76rem]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-border"
              checked={manualEnabled}
              onChange={(event) => setManualEnabled(event.target.checked)}
            />
            <span>Enable online manual search</span>
          </label>
          <p className="mt-2 text-[0.66rem] text-muted-foreground">
            Source: {sourceLabel(settings.manual.source)}
            {settings.manual.provider_label ? ` · ${settings.manual.provider_label}` : ""}
          </p>
          {settings.manual.reason && (
            <p className="mt-1 break-words text-[0.66rem] leading-relaxed text-brass">
              {settings.manual.reason}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-border/65 bg-background/35 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[0.86rem] font-medium">Reference-image search</h3>
            <Badge
              variant={
                settings.reference.configured && settings.reference.policy_configured
                  ? "sage"
                  : "outline"
              }
            >
              {settings.reference.configured && settings.reference.policy_configured
                ? "Ready"
                : settings.reference.configured
                  ? "Needs domains"
                  : "Not configured"}
            </Badge>
          </div>
          <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
            Look up a product image for review. Downloads happen only from your
            permitted source domains and still require manual acceptance.
          </p>
          <label className="mt-3 flex items-start gap-2.5 text-[0.76rem]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-border"
              checked={referenceEnabled}
              onChange={(event) => setReferenceEnabled(event.target.checked)}
            />
            <span>Enable reference-image search</span>
          </label>
          <p className="mt-2 text-[0.66rem] text-muted-foreground">
            Source: {sourceLabel(settings.reference.source)}
            {settings.reference.provider_label
              ? ` · ${settings.reference.provider_label}`
              : ""}
          </p>
          {settings.reference.reason && (
            <p className="mt-1 break-words text-[0.66rem] leading-relaxed text-brass">
              {settings.reference.reason}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Field
          label={settings.has_api_key ? "Replace Brave Search API key" : "Brave Search API key"}
          htmlFor="online-search-key"
          hint={settings.has_api_key ? "Blank keeps the saved key" : "Write-only"}
        >
          <Input
            id="online-search-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              settings.has_api_key
                ? `Saved key · v${settings.api_key_version}. Enter a replacement.`
                : "Paste the Brave Search subscription token"
            }
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.66rem] text-muted-foreground">
            {settings.has_api_key ? (
              <>
                <Badge variant="sage">
                  <KeyRound className="size-3" /> Key saved · v{settings.api_key_version}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoveOpen(true)}
                  disabled={removeKey.isPending}
                >
                  {removeKey.isPending ? <Spinner /> : <Trash2 />}
                  Remove key
                </Button>
              </>
            ) : (
              <span>No household Brave key saved.</span>
            )}
          </div>
        </Field>

        <Field
          label="Permitted reference-image source domains"
          htmlFor="online-search-domains"
          hint="One per line; subdomains included"
        >
          <Textarea
            id="online-search-domains"
            className="min-h-28 font-mono text-[0.74rem]"
            value={domainsText}
            onChange={(event) => setDomainsText(event.target.value)}
            placeholder={"example.com\nmanufacturer.com"}
          />
          <p className="mt-2 text-[0.66rem] leading-relaxed text-muted-foreground">
            Required before automatic reference-image downloads. Enter registrable
            domains only; schemes, paths, ports and wildcards are rejected. Source
            pages and license evidence are still recorded for every accepted image.
          </p>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save.mutate()} disabled={saveDisabled}>
          {save.isPending ? <Spinner /> : <CheckCircle2 />}
          Save online search
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            testConnection.isPending ||
            (!settings.manual.configured && !settings.reference.configured)
          }
          onClick={() => setTestConfirmOpen(true)}
        >
          {testConnection.isPending ? <Spinner /> : <Wifi />}
          Test connection
        </Button>
        <span className="text-[0.66rem] text-muted-foreground">
          Brave is the only supported provider in this release.
        </span>
      </div>

      {keyMissing && (
        <p className="mt-2 text-[0.7rem] text-brass">
          Enter a Brave key before enabling manual or reference-image search.
        </p>
      )}
      {domainsMissing && (
        <p className="mt-2 text-[0.7rem] text-brass">
          Add at least one permitted source domain before enabling reference-image search.
        </p>
      )}
      {formError && <div className="mt-3"><FormError message={formError} /></div>}
      {testResult && (
        <p
          className={
            testResult.ok
              ? "mt-3 rounded-xl border border-sage/20 bg-sage-soft/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-accent-foreground"
              : "mt-3 rounded-xl border border-destructive/20 bg-destructive/[0.05] px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-destructive"
          }
        >
          {testResult.message}
        </p>
      )}

      <details className="mt-4 rounded-xl border border-border/60 bg-background/30 px-3.5 py-3 text-[0.68rem] leading-relaxed text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground/80">
          Installation fallback and advanced gateway
        </summary>
        <p className="mt-2">
          If no household online-search settings have been saved, the installation
          environment can supply <code>BRAVE_SEARCH_API_KEY</code>, its enable flags
          and <code>ITEM_IMAGE_PERMITTED_SOURCE_DOMAINS</code>. Saving this card makes
          household settings authoritative, including explicit disable and key
          removal. The advanced <code>MANUAL_SEARCH_URL</code> gateway remains an
          operator-only installation fallback and is not edited here.
        </p>
        <p className="mt-1">
          Existing Brave image permission, license, SSRF and download limits continue
          to apply. This card cannot widen them.
        </p>
      </details>

      <ConfirmDialog
        open={testConfirmOpen}
        onOpenChange={setTestConfirmOpen}
        title="Test Brave Search connection?"
        description="This sends one bounded request with a fixed neutral query to Brave and may use subscription quota. No inventory, manual, borrower or household content is sent. It does not save changes."
        confirmLabel="Run connection test"
        onConfirm={async () => {
          await testConnection.mutateAsync();
        }}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove the Brave Search key?"
        description="Manual and reference-image search will be disabled for this household. Permitted source domains are kept, and installation fallback will not reactivate because household settings remain authoritative."
        confirmLabel="Remove key"
        onConfirm={async () => {
          await removeKey.mutateAsync();
        }}
      />
    </section>
  );
}
