import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  ImagePlus,
  Loader2,
  Package,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { recognitionProcessing } from "@/lib/recognition";
import {
  queryKeys,
  useAiStatus,
  useCategories,
  useItems,
  useRecognition,
  useRecognitions,
  useTags,
} from "@/lib/queries";
import type {
  AiRecognition,
  AiRecognitionSuggestion,
  Category,
  ItemDetailResponse,
  PhotoList,
  Tag,
} from "@/lib/types";
import { formatDate } from "@/lib/utils";

export function RecognitionPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const aiStatus = useAiStatus("vision");
  const recognitionsQuery = useRecognitions();
  const categoriesQuery = useCategories();
  const tagsQuery = useTags();
  const itemsQuery = useItems({ sort: "name_asc" }, 100);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const recognitionQuery = useRecognition(activeId ?? undefined);
  const [file, setFile] = React.useState<File | null>(null);
  const [suggestionIndex, setSuggestionIndex] = React.useState(0);
  const [initializedFor, setInitializedFor] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [brand, setBrand] = React.useState("");
  const [model, setModel] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">("new");
  const [targetItemId, setTargetItemId] = React.useState("");
  const [attachPhoto, setAttachPhoto] = React.useState(true);

  const upload = useMutation({
    mutationFn: (selected: File) => {
      const formData = new FormData();
      formData.append("file", selected);
      return api.postForm<AiRecognition>("/ai/recognitions", formData);
    },
    onSuccess: (recognition) => {
      setFile(null);
      setActiveId(recognition.id);
      setInitializedFor(null);
      void queryClient.invalidateQueries({ queryKey: ["ai", "recognitions"] });
      toast.success("Photo queued for recognition");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const retry = useMutation({
    mutationFn: (recognitionId: string) =>
      api.post<AiRecognition>(`/ai/recognitions/${recognitionId}/retry`),
    onSuccess: () => {
      setInitializedFor(null);
      void queryClient.invalidateQueries({ queryKey: ["ai", "recognition"] });
      toast.success("Recognition queued again");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Give the item a name first.");
      const categoryId = await ensureCategory(category.trim());
      const tagIds = await ensureTags(tags);
      let itemId = targetItemId;
      if (targetMode === "new") {
        const response = await api.post<ItemDetailResponse>("/items", {
          name: name.trim(),
          description: description.trim() || null,
          brand: brand.trim() || null,
          model: model.trim() || null,
          category_id: categoryId,
          tag_ids: tagIds,
          quantity: 1,
          condition: "good",
        });
        itemId = response.item.id;
      } else {
        if (!itemId) throw new Error("Choose an existing item.");
        const existing = items.find((item) => item.id === itemId);
        const combinedTags = Array.from(
          new Set([...(existing?.tags.map((tag) => tag.id) ?? []), ...tagIds]),
        );
        await api.patch<ItemDetailResponse>(`/items/${itemId}`, {
          name: name.trim(),
          description: description.trim() || null,
          brand: brand.trim() || null,
          model: model.trim() || null,
          category_id: categoryId,
          tag_ids: combinedTags,
        });
      }
      if (attachPhoto) {
        const photo = await recognitionImageFile();
        if (photo) {
          const formData = new FormData();
          formData.append("files", photo);
          await api.postForm<PhotoList>(`/items/${itemId}/photos`, formData);
        }
      }
      return itemId;
    },
    onSuccess: (itemId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.items });
      void queryClient.invalidateQueries({ queryKey: ["item"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tags });
      toast.success(targetMode === "new" ? "Item created" : "Item updated");
      navigate(`/items/${itemId}`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const recognition = recognitionQuery.data;
  const processing = recognition ? recognitionProcessing(recognition) : null;
  const suggestions = recognition?.result.suggestions ?? [];

  React.useEffect(() => {
    if (!recognition || recognition.id === initializedFor) return;
    const first = suggestions[0];
    if (recognition.status === "succeeded" && first) {
      applySuggestion(first);
      setInitializedFor(recognition.id);
    }
  }, [recognition, initializedFor, suggestions]);

  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const categories = categoriesQuery.data?.items ?? [];

  const applySuggestion = (suggestion: AiRecognitionSuggestion) => {
    setName(suggestion.name);
    setDescription(suggestion.description ?? "");
    setBrand(suggestion.brand ?? "");
    setModel(suggestion.model ?? "");
    setCategory(suggestion.category ?? "");
    setTags(suggestion.tags.join(", "));
  };

  const ensureCategory = async (value: string): Promise<string | null> => {
    if (!value) return null;
    const existing = categories.find(
      (entry) => entry.name.toLowerCase() === value.toLowerCase(),
    );
    if (existing) return existing.id;
    const response = await api.post<Category>("/categories", { name: value });
    void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    return response.id;
  };

  const ensureTags = async (value: string): Promise<string[]> => {
    const names = value
      .split(",")
      .map((tag) => tag.trim().replace(/^#/, ""))
      .filter(Boolean);
    const ids: string[] = [];
    for (const tagName of names) {
      const existing = tagsQuery.data?.items.find(
        (tag) => tag.name.toLowerCase() === tagName.toLowerCase(),
      );
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const response = await api.post<Tag>("/tags", { name: tagName });
      ids.push(response.id);
    }
    if (names.length > 0) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tags });
    }
    return ids;
  };

  const recognitionImageFile = async (): Promise<File | null> => {
    if (file) return file;
    if (!recognition) return null;
    const response = await fetch(recognition.image_url, { credentials: "include" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], recognition.original_filename, {
      type: recognition.content_type,
    });
  };

  const onSelectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (selected) upload.mutate(selected);
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Intelligence"
        title="Recognise an item"
        description="Photograph a possession, review suggested details, then create a new item or apply the changes to an existing one."
        actions={
          <Button variant="outline" asChild>
            <Link to="/assistant">
              <Sparkles />
              Ask Housetory
            </Link>
          </Button>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(330px,1fr)]">
        <div className="space-y-5">
          <section className="surface overflow-hidden">
            {recognition ? (
              <div className="relative">
                <img
                  src={recognition.image_url}
                  alt={recognition.original_filename}
                  className="max-h-[62vh] w-full bg-secondary/30 object-contain"
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 p-4">
                  <div>
                    <p className="text-[0.82rem] font-medium">
                      {recognition.original_filename}
                    </p>
                    <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
                      {recognition.width} × {recognition.height} ·{" "}
                      {formatDate(recognition.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        recognition.status === "succeeded"
                          ? "sage"
                          : recognition.status === "failed"
                            ? "destructive"
                            : "brass"
                      }
                    >
                      {recognition.status}
                    </Badge>
                    {recognition.status === "failed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(recognition.id)}
                      >
                        {retry.isPending ? <Spinner /> : <RefreshCw />}
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  <ImagePlus className="size-7" strokeWidth={1.5} />
                </span>
                <p className="mt-5 font-display text-2xl tracking-[-0.025em]">
                  Start with a photograph
                </p>
                <p className="mt-2 max-w-md text-[0.8rem] leading-relaxed text-muted-foreground">
                  AI vision is used when configured. Without a model, readable text on
                  packaging can still provide an OCR-based suggestion.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <label
                    htmlFor="recognition-upload"
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-4 py-2 text-[0.78rem] font-medium text-primary-foreground"
                  >
                    <Upload className="size-4" /> Choose photo
                  </label>
                  <label
                    htmlFor="recognition-camera"
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border px-4 py-2 text-[0.78rem] font-medium sm:hidden"
                  >
                    <Camera className="size-4" /> Take photo
                  </label>
                </div>
              </div>
            )}
            <input
              id="recognition-upload"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="sr-only"
              onChange={onSelectFile}
            />
            <input
              id="recognition-camera"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={onSelectFile}
            />
            {upload.isPending && (
              <div className="flex items-center justify-center gap-2 border-t border-border/60 p-5 text-[0.8rem] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Uploading photograph…
              </div>
            )}
          </section>

          {recognition?.status === "queued" || recognition?.status === "processing" ? (
            <div className="surface flex items-center gap-3 p-5 text-[0.82rem] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading the photograph on the server…
            </div>
          ) : recognition?.status === "failed" ? (
            <div className="surface border-destructive/25 p-5">
              <p className="text-[0.82rem] font-medium text-destructive">
                Recognition failed
              </p>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
                {recognition.error ||
                  "Configure a vision-capable model or upload a photo with readable text."}
              </p>
            </div>
          ) : recognition?.status === "succeeded" ? (
            <section className="surface space-y-5 p-5 sm:p-6">
              <div>
                <h2 className="font-display text-[1.45rem] tracking-[-0.025em]">
                  Review the suggestion
                </h2>
                {processing && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.78rem] text-muted-foreground">
                    <Badge variant={processing.variant}>{processing.label}</Badge>
                    <span>{processing.detail}</span>
                    {recognition.confidence != null ? (
                      <span>· {recognition.confidence}% confidence</span>
                    ) : null}
                  </div>
                )}
                {processing && processing.warnings.length > 0 && (
                  <div className="mt-3 rounded-xl border border-brass/20 bg-brass-soft/50 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
                    {processing.warnings.join(" ")}
                  </div>
                )}
                {suggestions[0]?.review && suggestions[0].review_reason && (
                  <div className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/40 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-brass">
                    <span className="font-medium">Review this observation. </span>
                    {suggestions[0].review_reason} It is not a confirmed possession.
                  </div>
                )}
              </div>

              {suggestions.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={`${suggestion.name}-${index}`}
                      type="button"
                      onClick={() => {
                        setSuggestionIndex(index);
                        applySuggestion(suggestion);
                      }}
                      className={
                        index === suggestionIndex
                          ? "rounded-full bg-primary px-3 py-1.5 text-[0.72rem] text-primary-foreground"
                          : "rounded-full border border-border px-3 py-1.5 text-[0.72rem] text-muted-foreground"
                      }
                    >
                      {suggestion.name}
                    </button>
                  ))}
                </div>
              )}

              {apply.error && <FormError message={getApiErrorMessage(apply.error)} />}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Item name" htmlFor="recognition-name">
                  <Input
                    id="recognition-name"
                    value={name}
                    maxLength={200}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label="Category" htmlFor="recognition-category" optional>
                  <Input
                    id="recognition-category"
                    value={category}
                    maxLength={80}
                    onChange={(event) => setCategory(event.target.value)}
                  />
                </Field>
                <Field label="Brand" htmlFor="recognition-brand" optional>
                  <Input
                    id="recognition-brand"
                    value={brand}
                    maxLength={120}
                    onChange={(event) => setBrand(event.target.value)}
                  />
                </Field>
                <Field label="Model" htmlFor="recognition-model" optional>
                  <Input
                    id="recognition-model"
                    value={model}
                    maxLength={120}
                    onChange={(event) => setModel(event.target.value)}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Description" htmlFor="recognition-description" optional>
                    <Textarea
                      id="recognition-description"
                      value={description}
                      maxLength={4000}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="Tags" htmlFor="recognition-tags" optional>
                    <Input
                      id="recognition-tags"
                      value={tags}
                      onChange={(event) => setTags(event.target.value)}
                      placeholder="kitchen, vintage"
                    />
                  </Field>
                </div>
              </div>

              <div className="rounded-xl border border-border/70 p-4">
                <p className="text-[0.8rem] font-medium">What should happen?</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTargetMode("new")}
                    className={
                      targetMode === "new"
                        ? "flex-1 rounded-lg bg-secondary px-3 py-2 text-[0.76rem] font-medium"
                        : "flex-1 rounded-lg border border-border px-3 py-2 text-[0.76rem] text-muted-foreground"
                    }
                  >
                    Create a new item
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetMode("existing")}
                    className={
                      targetMode === "existing"
                        ? "flex-1 rounded-lg bg-secondary px-3 py-2 text-[0.76rem] font-medium"
                        : "flex-1 rounded-lg border border-border px-3 py-2 text-[0.76rem] text-muted-foreground"
                    }
                  >
                    Update an existing item
                  </button>
                </div>
                {targetMode === "existing" && (
                  <div className="mt-3">
                    <Field label="Existing item" htmlFor="recognition-existing">
                      <Select
                        id="recognition-existing"
                        value={targetItemId}
                        onChange={(event) => setTargetItemId(event.target.value)}
                      >
                        <option value="">Choose an item</option>
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.room?.name ?? "No room"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
                <label className="mt-3 flex items-center gap-2 text-[0.75rem]">
                  <input
                    type="checkbox"
                    checked={attachPhoto}
                    onChange={(event) => setAttachPhoto(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Add this photograph to the item
                </label>
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[0.7rem] text-muted-foreground">
                  Nothing changes until you review and confirm.
                </p>
                <Button
                  disabled={
                    apply.isPending ||
                    !name.trim() ||
                    (targetMode === "existing" && !targetItemId)
                  }
                  onClick={() => apply.mutate()}
                >
                  {apply.isPending ? <Spinner /> : <Check />}
                  {targetMode === "new" ? "Create item" : "Update item"}
                </Button>
              </div>
            </section>
          ) : (
            <section className="surface p-5 text-[0.82rem] text-muted-foreground">
              Choose a photograph or open a recent recognition to begin.
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Recognition mode
            </h2>
            <p className="mt-2 text-[0.8rem] leading-relaxed text-muted-foreground">
              {aiStatus.data?.available
                ? `A vision-capable model is configured (${aiStatus.data.model}).`
                : "No vision model is available. Housetory will fall back to OCR text and mark suggestions as inferred."}
            </p>
            <Button variant="outline" size="sm" className="mt-3" asChild>
              <Link to="/settings">AI settings</Link>
            </Button>
          </section>

          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Recent recognitions
            </h2>
            <div className="mt-3 space-y-2">
              {recognitionsQuery.isPending ? (
                <p className="py-4 text-center text-[0.75rem] text-muted-foreground">
                  Loading…
                </p>
              ) : (recognitionsQuery.data?.items.length ?? 0) === 0 ? (
                <p className="py-4 text-center text-[0.75rem] text-muted-foreground">
                  No photographs yet.
                </p>
              ) : (
                recognitionsQuery.data?.items.slice(0, 8).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setActiveId(entry.id);
                      setInitializedFor(null);
                      setSuggestionIndex(0);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary/50"
                  >
                    <img
                      src={entry.image_url}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded-lg object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.75rem] font-medium">
                        {entry.original_filename}
                      </span>
                      <span className="block text-[0.66rem] text-muted-foreground">
                        {entry.status} · {formatDate(entry.created_at)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="surface p-5">
            <h2 className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <Package className="size-3.5" /> Privacy
            </h2>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-muted-foreground">
              Local models keep the photograph on your server. Cloud vision requires
              explicit configuration and consent. The original photo is private and
              authenticated.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
