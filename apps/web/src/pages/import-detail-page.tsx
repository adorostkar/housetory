import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  FileArchive,
  FileText,
  Folder,
  FolderTree,
  Link2Off,
  MapPin,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { HierarchyReview } from "@/components/hierarchy-review";
import { ErrorState } from "@/components/error-state";
import { ImportEntryCard } from "@/components/import-entry-card";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import {
  IMPORT_SOURCE_LABELS,
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_TONE,
} from "@/lib/labels";
import {
  queryKeys,
  useCategories,
  useImportBatch,
  useInvalidateInventory,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type {
  ImportApplyResult,
  ImportBatchDetail,
  ImportDecision,
  ImportEntry,
  ProposedItem,
  Room,
  StorageLocation,
} from "@/lib/types";
import { formatDate, pluralize } from "@/lib/utils";
import { enhancementLabel, keepManualEdits, proposalValue } from "@/lib/enrichment";

export function ImportDetailPage({
  batchId: providedBatchId,
  embedded = false,
}: {
  batchId?: string;
  embedded?: boolean;
} = {}) {
  const { batchId: routeBatchId = "" } = useParams();
  const batchId = providedBatchId ?? routeBatchId;
  const batchQuery = useImportBatch(batchId);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const categoriesQuery = useCategories();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { getImportReviewDraft, saveImportReviewDraft } = useAssistantDocuments();
  const [edits, setEdits] = React.useState<Record<string, ProposedItem>>({});
  const [decisions, setDecisions] = React.useState<Record<string, ImportDecision>>({});
  const [initializedBatchId, setInitializedBatchId] = React.useState("");
  const initialized = initializedBatchId === batchId;
  const [summary, setSummary] = React.useState<ImportApplyResult | null>(null);

  React.useEffect(() => {
    setSummary(null);
  }, [batchId]);

  const batch = batchQuery.data;
  React.useEffect(() => {
    if (!batch || batch.id !== batchId || initialized) return;
    if (batch.status !== "review" && batch.status !== "completed") return;
    const savedDraft = getImportReviewDraft(batchId);
    const nextEdits = { ...(savedDraft?.edits ?? {}) };
    for (const entry of batch.entries) {
      if (!(entry.id in nextEdits)) nextEdits[entry.id] = entry.proposed;
    }
    const nextDecisions = { ...(savedDraft?.decisions ?? {}) };
    const duplicateThreshold = batch.metadata.hierarchy === true ? 55 : 70;
    for (const entry of batch.entries) {
      const highDuplicate = entry.duplicate_candidates.find(
        (candidate) => candidate.score >= duplicateThreshold,
      );
      const final = [
        "imported",
        "merged",
        "skipped",
        "rejected",
        "failed",
      ].includes(entry.status);
      if (final) {
        nextDecisions[entry.id] = {
          include: false,
          action: entry.status === "failed" ? "import" : "skip",
          mergeItemId: entry.matched_item_id ?? "",
          mergeFields: [],
        };
      } else if (!(entry.id in nextDecisions)) {
        const needsReview = entry.proposed.relationships?.review === true;
        nextDecisions[entry.id] = {
          include: !highDuplicate && !needsReview,
          action: highDuplicate ? "skip" : "import",
          mergeItemId: highDuplicate?.item_id ?? "",
          mergeFields: highDuplicate ? ["serial_number"] : [],
        };
      }
    }
    setEdits(nextEdits);
    setDecisions(nextDecisions);
    setInitializedBatchId(batchId);
  }, [batch, batchId, getImportReviewDraft, initialized]);

  React.useEffect(() => {
    if (!initialized || !batch || batch.id !== batchId) return;
    saveImportReviewDraft(batchId, { edits, decisions });
  }, [batch, batchId, decisions, edits, initialized, saveImportReviewDraft]);

  const retry = useMutation({
    mutationFn: () => api.post(`/imports/${batchId}/retry`),
    onSuccess: () => {
      setInitializedBatchId("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.importBatch(batchId) });
      toast.success("Import queued again");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const retryEnhancement = useMutation({
    mutationFn: (action: "retry" | "cancel") =>
      api.post<ImportBatchDetail>(`/imports/${batchId}/enhancement/${action}`),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.importBatch(batchId), result);
      if (result.enhancement?.status === "off") {
        toast.info("AI is off. Configure a model and consent in Settings; local review is ready.");
      } else {
        toast.success(result.enhancement?.status === "queued"
          ? "Local review is ready; AI suggestions will run separately"
          : "AI suggestions cancelled; local review is unchanged");
      }
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const acceptEnhancement = useMutation({
    mutationFn: async () => ({
      before: batch,
      after: await api.post<ImportBatchDetail>(`/imports/${batchId}/enhancement/accept`),
    }),
    onSuccess: ({ before, after }) => {
      const nextEdits = Object.fromEntries(after.entries.map((entry) => {
        const base = before?.entries.find((item) => item.id === entry.id);
        const edited = edits[entry.id];
        return [entry.id, base && edited
          ? keepManualEdits(base.proposed, edited, entry.proposed)
          : entry.proposed];
      }));
      setEdits(nextEdits);
      saveImportReviewDraft(batchId, { edits: nextEdits, decisions });
      queryClient.setQueryData(queryKeys.importBatch(batchId), after);
      setInitializedBatchId("");
      toast.success("Suggestions loaded into review. Manual edits were kept; apply is still separate.");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const apply = useMutation({
    mutationFn: () => {
      const hierarchy = batch?.metadata.hierarchy === true;
      const entries = Object.entries(decisions)
        .filter(([, decision]) => decision.include || decision.action === "reject")
        .map(([id, decision]) => {
          const entry = batch?.entries.find((candidate) => candidate.id === id);
          if (decision.action === "merge") {
            if (!decision.mergeItemId || decision.mergeFields.length === 0) {
              throw new Error("Choose an existing item and at least one merge field.");
            }
            return {
              id,
              action: decision.action,
              proposed: edits[id],
              merge_item_id: decision.mergeItemId,
              merge_fields: decision.mergeFields,
            };
          }
          return {
            id,
            action: decision.action,
            proposed: edits[id],
            ...(hierarchy
              ? {
                  entity_type:
                    decision.entityType ??
                    (entry?.entity_type as typeof decision.entityType) ??
                    "item",
                  parent_entry_id:
                    decision.parentEntryId !== undefined
                      ? decision.parentEntryId
                      : (entry?.parent_entry_id ?? null),
                  legacy_identifier:
                    decision.legacyIdentifier !== undefined
                      ? decision.legacyIdentifier
                      : (entry?.legacy_identifier ?? null),
                  allow_duplicate: Boolean(decision.allowDuplicate),
                }
              : {}),
          };
        });
      if (entries.length === 0) throw new Error("Select at least one entry to apply.");
      return api.post<ImportApplyResult>(`/imports/${batchId}/apply`, { entries });
    },
    onSuccess: (result) => {
      setSummary(result);
      setInitializedBatchId("");
      queryClient.setQueryData(queryKeys.importBatch(batchId), result.batch);
      invalidate();
      toast.success(
        `${result.created} imported · ${result.skipped} skipped · ${result.failed} failed`,
      );
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const createRoom = async (_entryId: string, name: string) => {
    const context = batch?.metadata.context as { property_id?: string } | undefined;
    const room = await api.post<Room>("/rooms", {
      name,
      property_id: context?.property_id,
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
    return room;
  };

  const createLocation = async (
    _entryId: string,
    roomId: string,
    name: string,
    parentId: string | null,
  ) => {
    const location = await api.post<StorageLocation>("/storage-locations", {
      room_id: roomId,
      name,
      kind: "other",
      parent_id: parentId,
    });
    void queryClient.invalidateQueries({ queryKey: ["locations"] });
    return location;
  };

  if (batchQuery.isPending) return <PageSkeleton variant="detail" />;
  if (batchQuery.isError) {
    return (
      <ErrorState
        title="This import is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void batchQuery.refetch()}
      />
    );
  }

  if (!batch) return <PageSkeleton variant="detail" />;
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const categories = categoriesQuery.data?.items ?? [];
  const progress = (batch.metadata.progress as
    | { stage?: string; message?: string }
    | undefined) ?? {};
  const reviewable = batch.status === "review" || batch.status === "completed";
  const hierarchyMode = batch.metadata.hierarchy === true;
  const contextPropertyId = (
    batch.metadata.context as { property_id?: string } | undefined
  )?.property_id;
  const scopedRooms = contextPropertyId
    ? rooms.filter((room) => room.property_id === contextPropertyId)
    : rooms;
  const rawContext = batch.metadata.context as
    | {
        room_id?: string;
        room_name?: string;
        location_id?: string;
        location_name?: string;
        location_identifier?: string;
      }
    | undefined;
  const importContext = rawContext?.room_id ? rawContext : undefined;
  const importContextLabel = [
    importContext?.room_name,
    importContext?.location_identifier || importContext?.location_name,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasOpenEntries = batch.entries.some((entry) => entry.status === "proposed");
  const selectedCount = Object.values(decisions).filter(
    (decision) => decision.include || decision.action === "reject",
  ).length;
  const allSelected =
    batch.entries.length > 0 &&
    batch.entries.every(
      (entry) =>
        decisions[entry.id]?.include ||
        entry.status !== "proposed" ||
        decisions[entry.id]?.action === "reject",
    );

  const setAll = (include: boolean) => {
    setDecisions((current) => {
      const next = { ...current };
      for (const entry of batch.entries) {
        if (entry.status !== "proposed") continue;
        next[entry.id] = {
          ...(next[entry.id] ?? {
            action: "import",
            mergeItemId: "",
            mergeFields: [],
          }),
          include,
        };
      }
      return next;
    });
  };

  return (
    <PageLayout
      className={embedded ? "space-y-3" : undefined}
      header={{
        eyebrow: embedded ? "Assistant review" : "Import review",
        title: batch.title,
        description: [
          IMPORT_SOURCE_LABELS[batch.source_type] ?? batch.source_type,
          batch.original_filename,
          formatDate(batch.created_at),
        ]
          .filter(Boolean)
          .join(" · "),
        ...(!embedded ? { backTo: "/imports", backLabel: "Imports" } : {}),
        ...(!embedded ? { actions: (
          <>
            {batch.source_url && (
              <Button variant="outline" asChild>
                <a href={batch.source_url}>
                  <Download />
                  Source
                </a>
              </Button>
            )}
            {batch.status === "failed" && (
              <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
                {retry.isPending ? <Spinner /> : <RefreshCw />}
                Retry
              </Button>
            )}
          </>
        ) } : {}),
      }}
    >
      <section className="surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={IMPORT_STATUS_TONE[batch.status] ?? "outline"}>
            {IMPORT_STATUS_LABELS[batch.status] ?? batch.status}
          </Badge>
          {batch.source_type === "vault" && (
            <Badge variant="outline">
              <FileArchive className="size-3" /> Vault
            </Badge>
          )}
          {hierarchyMode && (
            <Badge variant="sage">
              <FolderTree className="size-3" /> Structured hierarchy
            </Badge>
          )}
          <Badge variant={batch.metadata.ai_used ? "brass" : "outline"}>
            {batch.metadata.ai_used ? (
              <>
                <Sparkles className="size-3" /> AI-assisted
              </>
            ) : (
              "Deterministic extraction"
            )}
          </Badge>
          {Boolean(batch.metadata.ai_error) && !batch.metadata.ai_used && (
            <Badge variant="outline">AI unavailable · used basic mode</Badge>
          )}
          <span className="text-2xs text-muted-foreground">
            {pluralize(batch.total_entries, "proposal")} · {batch.imported_entries} imported ·{" "}
            {batch.skipped_entries} skipped · {batch.failed_entries} failed
          </span>
          {batch.enhancement && (
            <Badge variant={batch.enhancement.status === "ready" ? "brass" : "outline"}>
              {enhancementLabel(batch.enhancement)}
            </Badge>
          )}
        </div>
        {batch.enhancement && batch.status === "review" && (
          <div className="mt-3 space-y-2 text-xs">
            <p className="text-muted-foreground">
              Local results are ready to review. Optional AI never applies inventory changes.
              {batch.enhancement.error && ` ${batch.enhancement.error}`}
            </p>
            {batch.enhancement.status === "ready" && batch.enhancement.proposals.length > 0 && (
              <details className="rounded-xl border border-brass/30 p-3">
                <summary className="cursor-pointer font-medium">Review AI suggestions</summary>
                <ul className="my-3 max-h-72 space-y-3 overflow-y-auto">
                  {batch.enhancement.proposals.map((proposal, index) => {
                    const base = batch.entries.find((entry) => entry.id === proposal.entry_id);
                    const baseFields = new Map<string, unknown>(Object.entries(base?.proposed ?? {}));
                    const changes = Object.entries(proposal.proposed).filter(
                      ([key, value]) => key !== "field_sources" && key !== "confidence" &&
                        JSON.stringify(value) !== JSON.stringify(baseFields.get(key)),
                    );
                    if (base && changes.length === 0 && base.entity_type === proposal.entity_type &&
                        base.legacy_identifier === proposal.legacy_identifier) return null;
                    return (
                      <li key={proposal.entry_id ?? `new-${index}`} className="space-y-1">
                        <p className="font-medium">{proposal.proposed.name}
                          {!base && " · new draft"}
                        </p>
                        {changes.map(([key, value]) => (
                          <p key={key} className="break-words text-2xs text-muted-foreground">
                            {key.replaceAll("_", " ")}: {proposalValue(baseFields.get(key))}
                            {" → "}{proposalValue(value)}
                          </p>
                        ))}
                        {base && base.entity_type !== proposal.entity_type && (
                          <p>Type: {base.entity_type} → {proposal.entity_type}</p>
                        )}
                        {base && base.legacy_identifier !== proposal.legacy_identifier && (
                          <p>Source identifier: {base.legacy_identifier || "Not set"}
                            {" → "}{proposal.legacy_identifier || "Not set"}
                          </p>
                        )}
                        {(base?.source_excerpt || proposal.source_excerpt) && (
                          <p className="line-clamp-3 text-2xs text-muted-foreground">
                            Source: {base?.source_excerpt || proposal.source_excerpt}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <Button size="sm" onClick={() => acceptEnhancement.mutate()}
                  disabled={acceptEnhancement.isPending || apply.isPending}>
                  {acceptEnhancement.isPending ? <Spinner /> : <Check />}
                  Load suggestions into review
                </Button>
                <p className="mt-2 text-2xs text-muted-foreground">
                  Your manual edits are kept. Nothing is added to inventory until you apply the review.
                </p>
              </details>
            )}
            {["off", "failed", "skipped"].includes(batch.enhancement.status) && (
              <Button size="sm" variant="outline" onClick={() => retryEnhancement.mutate("retry")}
                disabled={retryEnhancement.isPending || apply.isPending}>
                {retryEnhancement.isPending ? <Spinner /> : <Sparkles />}
                {batch.enhancement.status === "off" ? "Check AI settings and try" : "Retry AI only"}
              </Button>
            )}
            {["queued", "running"].includes(batch.enhancement.status) && (
              <Button size="sm" variant="ghost" onClick={() => retryEnhancement.mutate("cancel")}
                disabled={retryEnhancement.isPending}>
                Skip AI suggestions
              </Button>
            )}
          </div>
        )}
        {batch.status === "queued" || batch.status === "processing" ? (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/30 px-4 py-5 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {progress.message || "Processing this source in the background…"}
          </div>
        ) : batch.status === "failed" ? (
          <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="size-4" /> Processing failed
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              {batch.error || "This source could not be processed."}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {hierarchyMode
              ? "Housetory detected a room and container hierarchy. Expand branches, edit names, quantities, types and parents, then approve the tree. Parents are created before their contents."
              : "Review the proposed entries. Nothing is written until you approve the selected entries. Missing rooms and places can be created inline."}
          </p>
        )}
        {batch.error && batch.status !== "failed" && (
          <p className="mt-3 text-2xs text-destructive">{batch.error}</p>
        )}
      </section>

      {importContext && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-sage/25 bg-sage-soft/35 px-3.5 py-3 text-2xs leading-relaxed text-muted-foreground">
          <MapPin className="mt-0.5 size-4 shrink-0 text-sage" />
          <span>
            Context destination:{" "}
            <strong className="font-medium text-foreground/90">
              {importContextLabel || "the originating room or place"}
            </strong>
            . It is used only for entries without their own destination. Source
            hierarchy and explicit locations are preserved; you can change any
            entry before approval.
          </span>
        </div>
      )}

      {summary && (
        <section className="mt-4 rounded-2xl border border-sage/30 bg-sage-soft/50 p-5">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Check className="size-4" /> Import applied
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            {[
              ["Created", summary.created],
              ["Merged", summary.merged],
              ["Skipped", summary.skipped],
              ["Rejected", summary.rejected],
              ["Failed", summary.failed],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-background/50 px-3 py-2">
                <p className="text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                  {label}
                </p>
                <p className="mt-1 font-display text-[1.3rem] tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          {summary.failures.length > 0 && (
            <div className="mt-3 space-y-1 text-2xs text-destructive">
              {summary.failures.map((failure) => (
                <p key={failure.entry_id}>{failure.message}</p>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/items">View items</Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSummary(null)}>
              Continue reviewing
            </Button>
          </div>
        </section>
      )}

      {batch.warnings.length > 0 && (
        <details className="mt-4 surface p-4 sm:p-5">
          <summary className="cursor-pointer text-xs font-medium">
            {pluralize(batch.warnings.length, "warning")}
          </summary>
          <ul className="mt-3 space-y-2 text-2xs leading-relaxed text-muted-foreground">
            {batch.warnings.map((warning, index) => (
              <li key={index} className="break-words">
                {String(warning.message ?? warning.type ?? "Warning")}
              </li>
            ))}
          </ul>
        </details>
      )}

      {(batch.vault_tree.length > 0 ||
        batch.ignored_notes.length > 0 ||
        batch.broken_links.length > 0 ||
        batch.files.length > 0) && (
        <section className="mt-4 grid gap-4 lg:grid-cols-2">
          {batch.vault_tree.length > 0 && (
            <VaultTree tree={batch.vault_tree} />
          )}
          <div className="space-y-3">
            {batch.files.length > 0 && (
              <details className="surface p-4">
                <summary className="cursor-pointer text-xs font-medium">
                  {pluralize(batch.files.length, "vault file")}
                </summary>
                <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto text-2xs">
                  {batch.files.map((file) => (
                    <li key={file.id} className="flex items-center gap-2">
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{file.relative_path}</span>
                      <a
                        href={file.url}
                        className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {batch.ignored_notes.length > 0 && (
              <details className="surface p-4">
                <summary className="cursor-pointer text-xs font-medium">
                  {pluralize(batch.ignored_notes.length, "ignored note")}
                </summary>
                <ul className="mt-3 space-y-1.5 text-2xs text-muted-foreground">
                  {batch.ignored_notes.map((note) => (
                    <li key={note.path}>
                      <span className="text-foreground/70">{note.path}</span> — {note.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {batch.broken_links.length > 0 && (
              <details className="surface p-4">
                <summary className="cursor-pointer text-xs font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <Link2Off className="size-3.5" /> {pluralize(batch.broken_links.length, "broken link")}
                  </span>
                </summary>
                <ul className="mt-3 space-y-1.5 text-2xs text-muted-foreground">
                  {batch.broken_links.map((link, index) => (
                    <li key={index}>
                      <span className="text-foreground/70">{link.note}</span> → {link.target}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      {reviewable && batch.entries.length > 0 && (
        <>
          {hasOpenEntries && (
          <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAll(!allSelected)}
                disabled={apply.isPending}
              >
                {allSelected ? "Clear all" : "Select all"}
              </Button>
              <span className="text-2xs text-muted-foreground">
                {selectedCount} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <p className="hidden text-2xs text-muted-foreground sm:block">
                Explicit approval creates only selected entries.
              </p>
              <Button
                size="sm"
                disabled={apply.isPending || acceptEnhancement.isPending || selectedCount === 0}
                onClick={() => apply.mutate()}
              >
                {apply.isPending ? <Spinner /> : <Check />}
                Approve selected
              </Button>
            </div>
          </div>
          )}

          {hierarchyMode ? (
            <div className="mt-3">
              <HierarchyReview
                entries={batch.entries}
                edits={edits}
                decisions={decisions}
                disabled={apply.isPending}
                onEdit={(entryId, proposed) =>
                  setEdits((current) => ({ ...current, [entryId]: proposed }))
                }
                onDecision={(entryId, decision) =>
                  setDecisions((current) => ({ ...current, [entryId]: decision }))
                }
              />
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {batch.entries.map((entry: ImportEntry) => (
                <ImportEntryCard
                  key={entry.id}
                  entry={entry}
                  proposed={edits[entry.id] ?? entry.proposed}
                  decision={
                    decisions[entry.id] ?? {
                      include: false,
                      action: "import",
                      mergeItemId: "",
                      mergeFields: [],
                    }
                  }
                  rooms={scopedRooms}
                  locations={locations}
                  categories={categories}
                  disabled={apply.isPending}
                  onProposedChange={(proposed) =>
                    setEdits((current) => ({ ...current, [entry.id]: proposed }))
                  }
                  onDecisionChange={(decision) =>
                    setDecisions((current) => ({ ...current, [entry.id]: decision }))
                  }
                  onCreateRoom={createRoom}
                  onCreateLocation={createLocation}
                />
              ))}
            </div>
          )}

          {hasOpenEntries && (
            <div className="sticky bottom-24 z-20 mt-4 flex justify-end lg:bottom-4">
              <Button
                size="lg"
                className="shadow-lift"
                disabled={apply.isPending || acceptEnhancement.isPending || selectedCount === 0}
                onClick={() => apply.mutate()}
              >
                {apply.isPending ? <Spinner /> : <Check />}
                Approve {selectedCount} {selectedCount === 1 ? "entry" : "entries"}
              </Button>
            </div>
          )}
        </>
      )}

      {reviewable && batch.entries.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No inventory entries were detected."
            description="The source may be mostly reference notes, a template, or a room description. Check the ignored notes above, or try a clearer source."
            actionLabel="Start another import"
            onAction={() => navigate("/imports")}
          />
        </div>
      )}
    </PageLayout>
  );
}

function VaultTree({
  tree,
}: {
  tree: Array<{
    name: string;
    path: string;
    type: "file" | "folder";
    children?: Array<{
      name: string;
      path: string;
      type: "file" | "folder";
      children?: unknown[];
    }>;
  }>;
}) {
  return (
    <details className="surface p-4">
      <summary className="cursor-pointer text-xs font-medium">
        Vault structure
      </summary>
      <div className="mt-3 max-h-72 overflow-auto text-2xs">
        {tree.map((node) => (
          <VaultNode key={node.path} node={node} depth={0} />
        ))}
      </div>
    </details>
  );
}

function VaultNode({
  node,
  depth,
}: {
  node: {
    name: string;
    path: string;
    type: "file" | "folder";
    children?: Array<{
      name: string;
      path: string;
      type: "file" | "folder";
      children?: unknown[];
    }>;
  };
  depth: number;
}) {
  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded px-1.5 py-1 text-muted-foreground"
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        {node.type === "folder" ? (
          <Folder className="size-3.5 shrink-0" />
        ) : (
          <FileText className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {node.children?.map((child) => (
        <VaultNode key={child.path} node={child as typeof node} depth={depth + 1} />
      ))}
    </div>
  );
}
