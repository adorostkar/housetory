import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Cloud,
  Eye,
  KeyRound,
  Laptop,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useAiSettings,
  useSession,
} from "@/lib/queries";
import type {
  AiProviderModel,
  AiProviderRecord,
  AiProviderTest,
  AiTaskSetting,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const PROVIDERS = [
  { value: "openai", label: "OpenAI", local: false },
  { value: "anthropic", label: "Anthropic Claude", local: false },
  { value: "gemini", label: "Google Gemini", local: false },
  { value: "xai", label: "xAI Grok", local: false },
  { value: "openrouter", label: "OpenRouter", local: false },
  { value: "ollama", label: "Ollama", local: true },
] as const;

const TASK_LABELS: Record<string, string> = {
  assistant: "General assistant",
  imports: "Smart imports",
  documents: "Document interpretation",
  search: "Natural-language search",
  vision: "Image recognition",
  labels: "Label summary headlines",
};

const CAPABILITY_LABELS: Record<string, string> = {
  text: "Text",
  vision: "Vision",
  structured: "Structured JSON",
  tools: "Tool calling",
};

interface ProviderDraft {
  provider: string;
  display_name: string;
  base_url: string;
  default_model: string;
  api_key: string;
  enabled: boolean;
  cloud_consent: boolean;
}

const emptyDraft: ProviderDraft = {
  provider: "openai",
  display_name: "OpenAI",
  base_url: "https://api.openai.com/v1",
  default_model: "",
  api_key: "",
  enabled: true,
  cloud_consent: false,
};

function providerLabel(value: string) {
  return PROVIDERS.find((provider) => provider.value === value)?.label ?? value;
}

function isLocal(value: string) {
  return value === "ollama";
}

export function AiSettingsPage() {
  const session = useSession();
  const settingsQuery = useAiSettings();
  const queryClient = useQueryClient();
  const settings = settingsQuery.data;
  const isOwner = session.data?.role === "owner";
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AiProviderRecord | null>(null);
  const [draft, setDraft] = React.useState<ProviderDraft>(emptyDraft);
  const [deleteTarget, setDeleteTarget] = React.useState<AiProviderRecord | null>(null);
  const [testResults, setTestResults] = React.useState<Record<string, AiProviderTest>>({});
  const [models, setModels] = React.useState<Record<string, AiProviderModel[]>>({});
  const [tasks, setTasks] = React.useState<Record<string, AiTaskSetting>>({});

  React.useEffect(() => {
    if (settings) {
      setTasks(
        Object.fromEntries(settings.tasks.map((task) => [task.task, task])),
      );
    }
  }, [settings]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiStatus });
  };

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft);
    setDialogOpen(true);
  };

  const openEdit = (provider: AiProviderRecord) => {
    setEditing(provider);
    setDraft({
      provider: provider.provider,
      display_name: provider.display_name,
      base_url: provider.base_url ?? "",
      default_model: provider.default_model ?? "",
      api_key: "",
      enabled: provider.enabled,
      cloud_consent: provider.cloud_consent,
    });
    setDialogOpen(true);
  };

  const saveProvider = useMutation({
    mutationFn: () => {
      const payload = {
        provider: draft.provider,
        display_name: draft.display_name.trim() || undefined,
        base_url: draft.base_url.trim() || null,
        default_model: draft.default_model.trim() || null,
        api_key: draft.api_key.trim() || undefined,
        enabled: draft.enabled,
        cloud_consent: draft.cloud_consent,
      };
      return editing
        ? api.patch<AiProviderRecord>(`/ai/providers/${editing.id}`, payload)
        : api.post<AiProviderRecord>("/ai/providers", payload);
    },
    onSuccess: () => {
      refresh();
      setDialogOpen(false);
      toast.success(editing ? "Provider updated" : "Provider added");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const removeProvider = useMutation({
    mutationFn: (providerId: string) => api.delete<void>(`/ai/providers/${providerId}`),
    onSuccess: () => {
      refresh();
      setDeleteTarget(null);
      toast.success("Provider removed");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const testProvider = useMutation({
    mutationFn: (provider: AiProviderRecord) =>
      api.post<AiProviderTest>(`/ai/providers/${provider.id}/test`),
    onSuccess: (result, provider) => {
      setTestResults((current) => ({ ...current, [provider.id]: result }));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const discoverModels = useMutation({
    mutationFn: (provider: AiProviderRecord) =>
      api.get<{ provider_id: string; models: AiProviderModel[]; error: string | null }>(
        `/ai/providers/${provider.id}/models`,
      ),
    onSuccess: (result) => {
      setModels((current) => ({ ...current, [result.provider_id]: result.models }));
      if (result.error) toast.error(result.error);
      else toast.success(`${result.models.length} model(s) discovered`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const saveTask = useMutation({
    mutationFn: (task: AiTaskSetting) =>
      api.put<AiTaskSetting>(`/ai/tasks/${task.task}`, {
        provider_id: task.provider_id,
        model: task.model,
        enabled: task.enabled,
      }),
    onSuccess: (task) => {
      setTasks((current) => ({ ...current, [task.task]: task }));
      refresh();
      toast.success(`${TASK_LABELS[task.task] ?? task.task} updated`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const rotate = useMutation({
    mutationFn: () =>
      api.post<{ rotated: number; failed: number }>("/ai/credentials/rotate"),
    onSuccess: (result) => {
      refresh();
      toast.success(`Re-encrypted ${result.rotated} credential(s)`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (session.isPending || settingsQuery.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-4 h-12 w-72" />
        <Skeleton className="mt-8 h-72 rounded-2xl" />
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div className="surface mx-auto max-w-lg p-8 text-center">
        <ShieldCheck className="mx-auto size-8 text-muted-foreground" />
        <h1 className="mt-4 font-display text-3xl tracking-[-0.03em]">Owner only.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Only the household owner can configure AI providers or credentials.
        </p>
        <Button asChild className="mt-6">
          <Link to="/settings">Back to settings</Link>
        </Button>
      </div>
    );
  }
  if (settingsQuery.isError) {
    return <FormError message={getApiErrorMessage(settingsQuery.error)} />;
  }
  if (!settings) return null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings · Intelligence"
        title="AI providers"
        description="Connect the models Housetory may use. API keys are encrypted at rest, never returned to the browser and never logged."
        backTo="/settings"
        backLabel="Settings"
        actions={
          <>
            <Button variant="outline" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
              {rotate.isPending ? <Spinner /> : <KeyRound />}
              Rotate credentials
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              Add provider
            </Button>
          </>
        }
      />

      {settings.warning && (
        <div className="mb-4 rounded-xl border border-brass/25 bg-brass-soft/45 px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
          {settings.warning}
        </div>
      )}
      <div className="mb-4 rounded-xl border border-border/70 bg-secondary/25 px-4 py-3 text-[0.73rem] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground/80">
          <ShieldCheck className="size-3.5 text-sage" /> Privacy boundary
        </p>
        <p className="mt-1">
          Configuring a cloud API key does <strong>not</strong> authorize sending household
          data. Cloud consent must be enabled separately for that provider. Local Ollama
          requests stay on your server. All provider calls originate from the backend.
        </p>
      </div>

      <section className="surface p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 text-muted-foreground" />
          <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Providers</h2>
        </div>
        {settings.providers.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-border/70 px-5 py-10 text-center">
            <p className="font-display text-2xl tracking-[-0.02em]">No provider configured.</p>
            <p className="mx-auto mt-2 max-w-md text-[0.8rem] leading-relaxed text-muted-foreground">
              Deterministic imports, search, QR labels and assistant answers continue to
              work. Add a provider when you want model-written assistance or vision.
            </p>
            <Button className="mt-5" onClick={openCreate}>
              <Plus /> Add the first provider
            </Button>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {settings.providers.map((provider) => {
              const result = testResults[provider.id];
              const providerModels = models[provider.id] ?? [];
              return (
                <article key={provider.id} className="rounded-xl border border-border/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[0.92rem] font-medium">{provider.display_name}</h3>
                        <Badge variant={provider.is_local ? "sage" : "brass"}>
                          {provider.is_local ? <Laptop className="size-3" /> : <Cloud className="size-3" />}
                          {provider.is_local ? "Local" : "Cloud"}
                        </Badge>
                        <Badge variant={provider.enabled ? "outline" : "secondary"}>
                          {provider.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {provider.cloud_consent && <Badge variant="brass">Data consent on</Badge>}
                      </div>
                      <p className="mt-1 break-all text-[0.68rem] text-muted-foreground">
                        {providerLabel(provider.provider)} · {provider.base_url}
                      </p>
                      <p className="mt-1 text-[0.7rem] text-muted-foreground">
                        {provider.default_model ?? "No default model"} ·{" "}
                        {provider.has_api_key ? "API key saved" : provider.is_local ? "No key" : "No API key"}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(provider)} aria-label="Edit provider">
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteTarget(provider)}
                        aria-label="Remove provider"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {provider.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">
                        {CAPABILITY_LABELS[capability] ?? capability}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={testProvider.isPending}
                      onClick={() => testProvider.mutate(provider)}
                    >
                      {testProvider.isPending ? <Spinner /> : <Wifi />} Test connection
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={discoverModels.isPending}
                      onClick={() => discoverModels.mutate(provider)}
                    >
                      {discoverModels.isPending ? <Spinner /> : <Eye />} Discover models
                    </Button>
                  </div>
                  {result && (
                    <p
                      className={cn(
                        "mt-2 text-[0.7rem]",
                        result.ok ? "text-accent-foreground" : "text-destructive",
                      )}
                    >
                      {result.message}
                    </p>
                  )}
                  {providerModels.length > 0 && (
                    <p className="mt-2 max-h-16 overflow-y-auto break-words text-[0.66rem] text-muted-foreground">
                      {providerModels.map((model) => model.id).join(", ")}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="surface mt-5 p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <SparklesIcon />
          <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Task defaults</h2>
        </div>
        <p className="mt-1 text-[0.75rem] text-muted-foreground">
          Choose a provider and model per task. Vision tasks require a model that advertises
          vision capability. Capability detection is conservative and can be corrected by
          entering the exact provider model name.
        </p>
        <div className="mt-5 space-y-3">
          {Object.values(tasks)
            .sort((left, right) => left.task.localeCompare(right.task))
            .map((task) => {
              const provider = settings.providers.find((entry) => entry.id === task.provider_id);
              const providerModels = provider ? models[provider.id] ?? [] : [];
              return (
                <div
                  key={task.task}
                  className="grid gap-2 rounded-xl border border-border/60 p-3 sm:grid-cols-[minmax(140px,0.7fr)_minmax(160px,1fr)_minmax(180px,1.2fr)_auto] sm:items-center"
                >
                  <div>
                    <p className="text-[0.78rem] font-medium">{TASK_LABELS[task.task] ?? task.task}</p>
                    <p className="text-[0.65rem] text-muted-foreground">
                      {task.enabled ? task.capabilities.join(" · ") || "No capabilities" : "Disabled"}
                    </p>
                  </div>
                  <Select
                    aria-label={`${TASK_LABELS[task.task]} provider`}
                    value={task.provider_id ?? ""}
                    onChange={(event) =>
                      setTasks((current) => ({
                        ...current,
                        [task.task]: {
                          ...task,
                          provider_id: event.target.value || null,
                          provider_label:
                            settings.providers.find((entry) => entry.id === event.target.value)
                              ?.display_name ?? null,
                        },
                      }))
                    }
                  >
                    <option value="">Not configured</option>
                    {settings.providers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.display_name}
                      </option>
                    ))}
                  </Select>
                  <div>
                    <Input
                      aria-label={`${TASK_LABELS[task.task]} model`}
                      value={task.model ?? ""}
                      list={provider ? `models-${provider.id}` : undefined}
                      onChange={(event) =>
                        setTasks((current) => ({
                          ...current,
                          [task.task]: { ...task, model: event.target.value || null },
                        }))
                      }
                      placeholder="Exact provider model name"
                    />
                    {provider && (
                      <datalist id={`models-${provider.id}`}>
                        {providerModels.map((model) => (
                          <option key={model.id} value={model.id} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={task.enabled}
                        onChange={(event) =>
                          setTasks((current) => ({
                            ...current,
                            [task.task]: { ...task, enabled: event.target.checked },
                          }))
                        }
                      />
                      On
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saveTask.isPending}
                      onClick={() => saveTask.mutate(task)}
                    >
                      {saveTask.isPending ? <Spinner /> : <Check />}
                      Save
                    </Button>
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      <section className="surface mt-5 p-5 text-[0.73rem] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground/80">
          <KeyRound className="size-3.5 text-brass" /> Credential operations
        </p>
        <p className="mt-2">
          Keys are encrypted with <code className="rounded bg-secondary px-1.5 py-0.5">AI_CREDENTIAL_KEY</code>{" "}
          from the deployment environment. To rotate, set the old key as{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5">AI_CREDENTIAL_KEY_PREVIOUS</code>,
          set the new key, restart the API/worker, then use Rotate credentials. Back up the
          key separately; a database backup cannot decrypt credentials without it.
        </p>
        <p className="mt-2">
          If the key is missing or wrong, provider calls fail closed. API keys are replaceable
          without re-creating the provider.
        </p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link to="/settings">Back to settings</Link>
        </Button>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit provider" : "Add provider"}</DialogTitle>
            <DialogDescription>
              Configure the provider endpoint and model. The API key is write-only.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveProvider.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="provider-type" className="text-[0.78rem] font-medium">Provider</label>
                <Select
                  id="provider-type"
                  className="mt-1.5"
                  value={draft.provider}
                  disabled={Boolean(editing)}
                  onChange={(event) => {
                    const provider = PROVIDERS.find((entry) => entry.value === event.target.value);
                    setDraft((current) => ({
                      ...current,
                      provider: event.target.value,
                      display_name: provider?.label ?? current.display_name,
                      base_url:
                        event.target.value === "ollama"
                          ? "http://host.docker.internal:11434"
                          : event.target.value === "anthropic"
                            ? "https://api.anthropic.com/v1"
                            : event.target.value === "gemini"
                              ? "https://generativelanguage.googleapis.com/v1beta"
                              : event.target.value === "xai"
                                ? "https://api.x.ai/v1"
                                : event.target.value === "openrouter"
                                  ? "https://openrouter.ai/api/v1"
                                  : "https://api.openai.com/v1",
                      cloud_consent: event.target.value === "ollama" ? false : current.cloud_consent,
                    }));
                  }}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label} {provider.local ? "(local)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="provider-name" className="text-[0.78rem] font-medium">Display name</label>
                <Input
                  id="provider-name"
                  className="mt-1.5"
                  value={draft.display_name}
                  maxLength={120}
                  onChange={(event) => setDraft((current) => ({ ...current, display_name: event.target.value }))}
                />
              </div>
            </div>
            <div>
              <label htmlFor="provider-url" className="text-[0.78rem] font-medium">Base URL</label>
              <Input
                id="provider-url"
                className="mt-1.5"
                value={draft.base_url}
                onChange={(event) => setDraft((current) => ({ ...current, base_url: event.target.value }))}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="provider-model" className="text-[0.78rem] font-medium">Default model</label>
                <Input
                  id="provider-model"
                  className="mt-1.5"
                  value={draft.default_model}
                  onChange={(event) => setDraft((current) => ({ ...current, default_model: event.target.value }))}
                  placeholder="Exact model name"
                />
              </div>
              <div>
                <label htmlFor="provider-key" className="text-[0.78rem] font-medium">
                  API key {editing && <span className="font-normal text-muted-foreground">(leave blank to keep)</span>}
                </label>
                <Input
                  id="provider-key"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1.5"
                  value={draft.api_key}
                  onChange={(event) => setDraft((current) => ({ ...current, api_key: event.target.value }))}
                  placeholder={editing?.has_api_key ? "Saved key — enter to replace" : "Provider API key"}
                />
              </div>
            </div>
            <label className="flex items-start gap-2 rounded-xl border border-border/60 p-3 text-[0.75rem]">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 accent-primary"
                checked={draft.enabled}
                onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>
                <span className="font-medium">Enable this provider</span>
                <span className="block text-[0.68rem] text-muted-foreground">
                  Disabling keeps the credential but prevents calls.
                </span>
              </span>
            </label>
            {!isLocal(draft.provider) && (
              <label className="flex items-start gap-2 rounded-xl border border-brass/25 bg-brass-soft/35 p-3 text-[0.75rem]">
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 accent-primary"
                  checked={draft.cloud_consent}
                  onChange={(event) => setDraft((current) => ({ ...current, cloud_consent: event.target.checked }))}
                />
                <span>
                  <span className="font-medium">I consent to sending household data to {providerLabel(draft.provider)}</span>
                  <span className="block text-[0.68rem] leading-relaxed text-muted-foreground">
                    This includes prompts, inventory excerpts, documents and photographs sent
                    for the selected tasks. You can revoke it here at any time.
                  </span>
                </span>
              </label>
            )}
            {saveProvider.error && <FormError message={getApiErrorMessage(saveProvider.error)} />}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saveProvider.isPending}>
                {saveProvider.isPending ? <Spinner /> : <Check />}
                {editing ? "Save provider" : "Add provider"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.display_name}?`}
        description="The credential and task assignments for this provider will be removed. Existing inventory is unchanged."
        confirmLabel="Remove provider"
        onConfirm={async () => {
          if (deleteTarget) await removeProvider.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function SparklesIcon() {
  return <RefreshCw className="size-4 text-brass" />;
}
