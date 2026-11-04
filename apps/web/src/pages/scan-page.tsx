import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Camera,
  Check,
  GitMerge,
  Loader2,
  MapPin,
  ScanLine,
  Split,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { CameraUpload } from "@/components/camera-upload";
import { Field } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useAiStatus,
  useInvalidateInventory,
  useItems,
  useLocations,
  useRecognition,
} from "@/lib/queries";
import type {
  AiRecognition,
  AiRecognitionApplyResult,
  AiRecognitionSuggestion,
  DuplicateCandidate,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

interface SuggestionState {
  include: boolean;
  action: "create" | "update" | "reject";
  proposal: AiRecognitionSuggestion;
  itemId: string;
  allowDuplicate: boolean;
  locationId: string;
  sourceIndex: number;
  entryKey: string;
}

export function ScanPage() {
  const [searchParams] = useSearchParams();
  const locationIdParam = searchParams.get("location_id") ?? "";
  const roomIdParam = searchParams.get("room_id") ?? "";
  const aiStatus = useAiStatus("vision");
  const locationsQuery = useLocations();
  const itemsQuery = useItems({ sort: "name_asc" }, 100);
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [recognitionId, setRecognitionId] = React.useState<string | null>(null);
  const recognitionQuery = useRecognition(recognitionId ?? undefined);
  const recognition = recognitionQuery.data;
  const locations = locationsQuery.data?.items ?? [];
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const [suggestions, setSuggestions] = React.useState<SuggestionState[]>([]);
  const [initializedFor, setInitializedFor] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<AiRecognitionApplyResult | null>(null);

  const defaultLocation = React.useMemo(
    () =>
      locationIdParam ||
      (recognition?.location_id ?? "") ||
      "",
    [locationIdParam, recognition?.location_id],
  );

  React.useEffect(() => {
    if (!recognition || recognition.id === initializedFor) return;
    if (recognition.status !== "succeeded") return;
    const raw = recognition.result.suggestions ?? [];
    const next = raw.map((suggestion, sourceIndex) => {
      const duplicates = duplicateFor(recognition, sourceIndex);
      return {
        include: true,
        action: "create" as const,
        proposal: suggestion,
        itemId: duplicates[0]?.item_id ?? "",
        allowDuplicate: false,
        locationId: defaultLocation,
        sourceIndex,
        entryKey: String(sourceIndex),
      };
    });
    setSuggestions(next);
    setInitializedFor(recognition.id);
    setResult(null);
  }, [recognition, initializedFor, defaultLocation]);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      if (defaultLocation) formData.append("location_id", defaultLocation);
      if (roomIdParam) formData.append("room_id", roomIdParam);
      return api.postForm<AiRecognition>("/ai/recognitions", formData);
    },
    onSuccess: (created) => {
      setRecognitionId(created.id);
      setInitializedFor(null);
      void queryClient.invalidateQueries({ queryKey: ["ai", "recognitions"] });
      toast.success("Photo queued for visual inventory");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<AiRecognitionApplyResult>(`/ai/recognitions/${recognitionId}/apply`, {
        entries: suggestions
          .filter((entry) => entry.include && entry.action !== "reject")
          .map((entry) => ({
            suggestion_index: entry.sourceIndex,
            entry_key: entry.entryKey,
            action: entry.action,
            proposal: entry.proposal,
            item_id: entry.action === "update" ? entry.itemId || null : null,
            location_id: entry.locationId || null,
            allow_duplicate: entry.allowDuplicate,
          })),
      }),
    onSuccess: (applied) => {
      setResult(applied);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiStatus });
      toast.success(`${applied.created} created · ${applied.updated} updated`);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const updateSuggestion = (index: number, patch: Partial<SuggestionState>) => {
    setSuggestions((current) =>
      current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
    );
  };

  const splitSuggestion = (index: number) => {
    setSuggestions((current) => {
      const target = current[index];
      if (!target) return current;
      const siblings = current.filter((entry) =>
        entry.entryKey.startsWith(`${target.entryKey}-split-`),
      ).length;
      const originalQuantity = target.proposal.quantity > 1 ? target.proposal.quantity - 1 : 1;
      const split: SuggestionState = {
        ...target,
        entryKey: `${target.entryKey}-split-${siblings + 1}`,
        include: true,
        allowDuplicate: true,
        proposal: {
          ...target.proposal,
          name: `${target.proposal.name} (split)`,
          quantity: 1,
          notes: [target.proposal.notes, "Split from another suggestion."]
            .filter(Boolean)
            .join("\n"),
        },
      };
      const updated = current.map((entry, entryIndex) =>
        entryIndex === index
          ? { ...entry, proposal: { ...entry.proposal, quantity: originalQuantity } }
          : entry,
      );
      return [...updated.slice(0, index + 1), split, ...updated.slice(index + 1)];
    });
  };

  const mergeWithNext = (index: number) => {
    setSuggestions((current) => {
      const first = current[index];
      const second = current[index + 1];
      if (!first || !second) return current;
      const merged: SuggestionState = {
        ...first,
        allowDuplicate: false,
        proposal: {
          ...first.proposal,
          name: `${first.proposal.name} + ${second.proposal.name}`,
          quantity: first.proposal.quantity + second.proposal.quantity,
          description:
            [first.proposal.description, second.proposal.description]
              .filter(Boolean)
              .join("\n") || null,
          tags: [...new Set([...first.proposal.tags, ...second.proposal.tags])],
          notes:
            [first.proposal.notes, second.proposal.notes, "Merged suggestions."]
              .filter(Boolean)
              .join("\n"),
          source: first.proposal.source,
          field_sources: {
            ...first.proposal.field_sources,
            ...second.proposal.field_sources,
          },
          confidence:
            first.proposal.confidence == null || second.proposal.confidence == null
              ? first.proposal.confidence ?? second.proposal.confidence
              : Math.min(first.proposal.confidence, second.proposal.confidence),
        },
      };
      const updated = current.map((entry, entryIndex) =>
        entryIndex === index ? merged : entry,
      );
      return [...updated.slice(0, index + 1), ...updated.slice(index + 2)];
    });
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Add items · Camera"
        title="Scan a photo"
        description="Photograph several objects at once, review every suggestion, choose destinations, then create only what you approve. Processing follows your configured local or consented remote model."
        actions={
          <Button variant="outline" asChild>
            <Link to="/items">Inventory</Link>
          </Button>
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <section className="surface p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <ScanLine className="size-4 text-brass" />
              <h2 className="font-display text-[1.4rem] tracking-[-0.02em]">Take or choose a photo</h2>
            </div>
            <p className="mt-1 text-[0.76rem] leading-relaxed text-muted-foreground">
              {aiStatus.data?.capabilities?.includes("vision")
                ? `A vision-capable model is selected (${aiStatus.data.model}).`
                : "No vision model is available. OCR text may produce limited suggestions; object recognition quality will be lower."}
            </p>
            <div className="mt-4 rounded-2xl border border-dashed border-border bg-secondary/20 p-6 text-center">
              {recognition ? (
                <img
                  src={recognition.image_url}
                  alt="Recognition source"
                  className="mx-auto max-h-[46vh] rounded-xl object-contain"
                />
              ) : (
                <>
                  <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <Camera className="size-6" strokeWidth={1.5} />
                  </span>
                  <p className="mt-3 text-[0.85rem] font-medium">Point at the objects you want to add</p>
                  <p className="mx-auto mt-1 max-w-md text-[0.72rem] leading-relaxed text-muted-foreground">
                    A whole-box photo can suggest multiple items. Nothing is written until you review and approve each suggestion.
                  </p>
                </>
              )}
              <div className="mt-4 flex justify-center">
                <CameraUpload
                  label="AI inventory photograph"
                  busy={upload.isPending}
                  onUpload={async (file) => {
                    await upload.mutateAsync(file);
                  }}
                />
              </div>
            </div>
            <Field label="Default destination" htmlFor="scan-location" optional>
              <Select
                id="scan-location"
                className="mt-2"
                value={defaultLocation}
                onChange={(event) => {
                  const value = event.target.value;
                  setSuggestions((current) =>
                    current.map((entry) => ({ ...entry, locationId: value })),
                  );
                }}
              >
                <option value="">No default destination</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.identifier ? `${location.identifier} · ` : ""}
                    {location.name}
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          {recognition && recognition.status !== "succeeded" && recognition.status !== "failed" && (
            <section className="surface flex items-center gap-3 p-5 text-[0.82rem] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              The backend is analysing the photo…
            </section>
          )}
          {recognition?.status === "failed" && (
            <section className="surface border-destructive/25 p-5">
              <p className="text-[0.82rem] font-medium text-destructive">Recognition failed</p>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
                {recognition.error || "Try another photograph or add the item manually."}
              </p>
              <Button className="mt-3" variant="outline" asChild>
                <Link to="/items/new">Add manually instead</Link>
              </Button>
            </section>
          )}

          {recognition?.status === "succeeded" && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">
                    Review {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
                  </h2>
                  <p className="mt-1 text-[0.74rem] text-muted-foreground">
                    {recognition.processing_mode === "cloud"
                      ? "Remote vision"
                      : recognition.processing_mode === "private"
                        ? "Private-network vision"
                        : recognition.processing_mode === "local"
                          ? "Local vision"
                          : "OCR fallback"}{" "}
                    · {recognition.model_name ?? "deterministic"} · {formatDate(recognition.created_at)}
                  </p>
                </div>
                <Button
                  disabled={apply.isPending || suggestions.every((entry) => !entry.include)}
                  onClick={() => apply.mutate()}
                >
                  {apply.isPending ? <Spinner /> : <Check />}
                  Approve selected
                </Button>
              </div>
              {suggestions.map((entry, index) => (
                <SuggestionCard
                  key={entry.entryKey}
                  index={index}
                  entry={entry}
                  duplicates={duplicateFor(recognition, entry.sourceIndex)}
                  items={items}
                  locations={locations}
                  canMerge={Boolean(suggestions[index + 1])}
                  onChange={(patch) => updateSuggestion(index, patch)}
                  onLocationChange={(value) => updateSuggestion(index, { locationId: value })}
                  onMerge={() => mergeWithNext(index)}
                  onSplit={() => splitSuggestion(index)}
                />
              ))}
            </section>
          )}

          {result && (
            <section className="surface border-sage/30 bg-sage-soft/40 p-5">
              <p className="flex items-center gap-2 text-[0.85rem] font-medium">
                <Check className="size-4" /> Scan applied
              </p>
              <p className="mt-1 text-[0.75rem] text-muted-foreground">
                {result.created} created · {result.updated} updated · {result.rejected} rejected ·{" "}
                {result.failed} failed
              </p>
              {result.failures.length > 0 && (
                <div className="mt-2 space-y-1 text-[0.72rem] text-destructive">
                  {result.failures.map((failure) => (
                    <p key={failure.suggestion_index}>{failure.message}</p>
                  ))}
                </div>
              )}
              <Button className="mt-3" size="sm" variant="outline" asChild>
                <Link to="/items">View inventory</Link>
              </Button>
            </section>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-8">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              How this works
            </h2>
            <ol className="mt-3 space-y-3 text-[0.75rem] leading-relaxed text-muted-foreground">
              <li><strong className="text-foreground/80">1.</strong> Take a photo with the rear camera or choose an existing image.</li>
              <li><strong className="text-foreground/80">2.</strong> The backend identifies separate objects; it never creates records automatically.</li>
              <li><strong className="text-foreground/80">3.</strong> Edit quantities and destinations, review duplicates, then approve selected suggestions.</li>
            </ol>
          </section>
          <section className="surface p-5 text-[0.72rem] leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground/80">
              <AlertTriangle className="size-3.5 text-brass" /> Accuracy note
            </p>
            <p className="mt-2">
              Photos can be ambiguous. Housetory will never invent serial numbers, prices, purchase
              dates or warranties. Review confidence, brand/model fields and destination before approving.
            </p>
            <p className="mt-2">
              The whole photograph is not automatically used as every item's cover.
            </p>
          </section>
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Contextual scan
            </h2>
            <p className="mt-2 text-[0.74rem] leading-relaxed text-muted-foreground">
              Scan from a container to default every suggestion into that box. Use the
              destination selector above to change it.
            </p>
            <Button variant="outline" size="sm" className="mt-3" asChild>
              <Link to="/containers">Choose a container</Link>
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function duplicateFor(recognition: AiRecognition, index: number): DuplicateCandidate[] {
  return (
    recognition.suggestion_duplicates?.find((entry) => entry.suggestion_index === index)
      ?.candidates ?? []
  );
}

function SuggestionCard({
  index,
  entry,
  duplicates,
  items,
  locations,
  onChange,
  onLocationChange,
  canMerge,
  onMerge,
  onSplit,
}: {
  index: number;
  entry: SuggestionState;
  duplicates: DuplicateCandidate[];
  items: Array<{ id: string; name: string; room: { name: string } | null }>;
  locations: Array<{ id: string; name: string; identifier: string | null }>;
  onChange: (patch: Partial<SuggestionState>) => void;
  onLocationChange: (value: string) => void;
  canMerge: boolean;
  onMerge: () => void;
  onSplit: () => void;
}) {
  const suggestion = entry.proposal;
  return (
    <article
      className={cn(
        "surface p-4 sm:p-5",
        entry.include ? "border-sage/40" : "opacity-75",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={entry.include}
            onChange={(event) => onChange({ include: event.target.checked })}
            aria-label={`Include ${suggestion.name}`}
          />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[0.92rem] font-medium">{suggestion.name}</h3>
              <Badge variant={suggestion.source === "vision" ? "sage" : "brass"}>
                {suggestion.source === "vision" ? "Vision" : "OCR text"}
              </Badge>
              {suggestion.confidence != null && (
                <Badge variant={suggestion.confidence >= 70 ? "sage" : "brass"}>
                  {suggestion.confidence}% confidence
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[0.68rem] text-muted-foreground">
              Suggestion {entry.sourceIndex + 1}
              {entry.entryKey.includes("-split-") ? " · split record" : ""}
            </p>
          </div>
        </div>
        <Select
          aria-label={`Action for ${suggestion.name}`}
          value={entry.action}
          onChange={(event) => onChange({ action: event.target.value as SuggestionState["action"] })}
          className="h-8 w-[130px] text-[0.72rem]"
        >
          <option value="create">Create new</option>
          <option value="update">Update existing</option>
          <option value="reject">Reject</option>
        </Select>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`scan-name-${index}`}>
          <Input
            id={`scan-name-${index}`}
            value={suggestion.name}
            maxLength={200}
            onChange={(event) =>
              onChange({ proposal: { ...suggestion, name: event.target.value } })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" htmlFor={`scan-qty-${index}`}>
            <Input
              id={`scan-qty-${index}`}
              type="number"
              min={0}
              value={suggestion.quantity}
              onChange={(event) =>
                onChange({
                  proposal: { ...suggestion, quantity: Math.max(0, Number(event.target.value) || 0) },
                })
              }
            />
          </Field>
          <Field label="Category" htmlFor={`scan-category-${index}`} optional>
            <Input
              id={`scan-category-${index}`}
              value={suggestion.category ?? ""}
              onChange={(event) =>
                onChange({ proposal: { ...suggestion, category: event.target.value || null } })
              }
            />
          </Field>
        </div>
        <Field label="Brand" htmlFor={`scan-brand-${index}`} optional>
          <Input
            id={`scan-brand-${index}`}
            value={suggestion.brand ?? ""}
            onChange={(event) =>
              onChange({ proposal: { ...suggestion, brand: event.target.value || null } })
            }
          />
        </Field>
        <Field label="Model" htmlFor={`scan-model-${index}`} optional>
          <Input
            id={`scan-model-${index}`}
            value={suggestion.model ?? ""}
            onChange={(event) =>
              onChange({ proposal: { ...suggestion, model: event.target.value || null } })
            }
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor={`scan-description-${index}`} optional>
            <Textarea
              id={`scan-description-${index}`}
              value={suggestion.description ?? ""}
              maxLength={4000}
              onChange={(event) =>
                onChange({
                  proposal: { ...suggestion, description: event.target.value || null },
                })
              }
            />
          </Field>
        </div>
      </div>

      {entry.action === "update" && (
        <Field label="Existing item" htmlFor={`scan-existing-${index}`} className="mt-3">
          <Select
            id={`scan-existing-${index}`}
            value={entry.itemId}
            onChange={(event) => onChange({ itemId: event.target.value })}
          >
            <option value="">Choose an item</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.room?.name ?? "No room"}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label="Destination" htmlFor={`scan-location-${index}`} optional>
          <Select
            id={`scan-location-${index}`}
            value={entry.locationId}
            onChange={(event) => onLocationChange(event.target.value)}
          >
            <option value="">No location</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.identifier ? `${location.identifier} · ` : ""}
                {location.name}
              </option>
            ))}
          </Select>
        </Field>
        {duplicates.length > 0 && (
          <div className="rounded-xl border border-brass/25 bg-brass-soft/40 p-3 text-[0.7rem] text-muted-foreground sm:col-span-2">
            <p className="flex items-center gap-1.5 font-medium text-brass">
              <AlertTriangle className="size-3.5" /> Possible existing items
            </p>
            {duplicates.map((candidate) => (
              <div key={candidate.item_id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {candidate.name} · {candidate.room_name ?? "No room"} · {candidate.score}%
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onChange({ action: "update", itemId: candidate.item_id })}
                  >
                    Update this item
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange({ allowDuplicate: true })}
                  >
                    Create anyway
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-[0.68rem] text-muted-foreground">
        <MapPin className="size-3" />
        <span className="mr-auto">
          {entry.include ? "Will be reviewed for creation" : "Excluded from this approval"}
          {entry.allowDuplicate && " · duplicate override enabled"}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!canMerge || entry.action === "update" || entry.action === "reject"}
          onClick={onMerge}
        >
          <GitMerge /> Merge with next
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={entry.action === "update" || entry.action === "reject"}
          onClick={onSplit}
        >
          <Split /> Split
        </Button>
      </div>
    </article>
  );
}
