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
import {
  hasImportEntryErrors,
  ImportEntryCard,
  validateImportEntry,
  type ImportEntryErrors,
} from "@/components/import-entry-card";
import { FindingsPhoto } from "@/components/findings-photo";
import { SkippedRow, SkippedSection } from "@/components/review-row";
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
import { plainForm, stableJson } from "@/lib/review-draft-store";
import { DraftSaveNotice, useDraftAutosave } from "@/lib/review-drafts";
import { formatDate, pluralize } from "@/lib/utils";
import { enhancementLabel, keepManualEdits, proposalValue } from "@/lib/enrichment";

/** The fields of a proposal that a person can change. */
const EDITABLE_FIELDS = [
  "name", "description", "quantity", "category", "brand", "model", "serial_number", "room",
  "storage_location", "purchase", "warranty", "tags", "notes", "collection", "relationships",
] as const satisfies ReadonlyArray<keyof ProposedItem>;
type EditableField = (typeof EDITABLE_FIELDS)[number];

/** A row that still waits for a decision. Only such a row has a draft to keep. */
const waits = (entry: ImportEntry) =>
  entry.status === "proposed" || entry.status === "approved" || entry.status === "failed";

function withoutReviewDraft(proposed: ProposedItem): ProposedItem {
  if (!proposed.relationships || !("review_draft" in proposed.relationships)) return proposed;
  const relationships = { ...proposed.relationships };
  delete relationships.review_draft;
  return { ...proposed, relationships };
}

/** The fields the server knows were changed by hand, from an earlier visit. */
function keptEditedFields(entry: ImportEntry): EditableField[] {
  const draft = entry.proposed.relationships?.review_draft as { edited_fields?: unknown } | undefined;
  const kept = Array.isArray(draft?.edited_fields) ? draft.edited_fields : [];
  return EDITABLE_FIELDS.filter((field) => kept.includes(field));
}

/** The fields that were changed by hand: the kept ones, and the ones that differ now. */
function editedFields(loaded: ProposedItem, kept: EditableField[], current: ProposedItem) {
  const before = withoutReviewDraft(loaded);
  const now = withoutReviewDraft(current);
  return EDITABLE_FIELDS.filter((field) =>
    kept.includes(field) ||
    JSON.stringify(now[field] ?? null) !== JSON.stringify(before[field] ?? null));
}

/**
 * The whole draft of a waiting row, as the server keeps it: the edited proposal and
 * the choices of the row. Selection is not part of it.
 */
function importDraftBody(
  entry: ImportEntry,
  proposed: ProposedItem,
  decision: ImportDecision,
  hierarchy: boolean,
  edited: EditableField[],
) {
  const clean = withoutReviewDraft(proposed);
  return {
    action: decision.action === "merge" ? "merge" : "import",
    // A name or a quantity that cannot be kept as it is now (empty, or not a whole
    // number) is kept as it was. The field on the page is not changed by this.
    proposed: {
      ...clean,
      name: clean.name.trim() ? clean.name : entry.proposed.name,
      quantity: Number.isInteger(clean.quantity) && clean.quantity >= 0
        ? clean.quantity : entry.proposed.quantity,
    },
    merge_item_id: decision.mergeItemId || null,
    merge_fields: decision.mergeFields,
    ...(hierarchy
      ? {
          entity_type: decision.entityType ?? (entry.entity_type as ImportDecision["entityType"]) ?? "item",
          parent_entry_id: decision.parentEntryId !== undefined
            ? decision.parentEntryId : (entry.parent_entry_id ?? null),
          legacy_identifier: decision.legacyIdentifier !== undefined
            ? decision.legacyIdentifier : (entry.legacy_identifier ?? null),
          allow_duplicate: Boolean(decision.allowDuplicate),
        }
      : {}),
    edited_fields: edited,
  };
}

/**
 * What the server has for a row. It is kept with the copy of a correction on this
 * device. When the review opens again, the copy is only used if the server still
 * has exactly this: then nobody corrected the row somewhere else in the meantime.
 */
function serverRow(entry: ImportEntry) {
  return {
    proposed: entry.proposed,
    entity_type: entry.entity_type ?? null,
    parent_entry_id: entry.parent_entry_id ?? null,
    legacy_identifier: entry.legacy_identifier ?? null,
  };
}

/** The review choices the server kept with a row (see `review_draft`). */
function reviewDraftOf(entry: ImportEntry): Partial<ImportDecision> {
  const draft = entry.proposed.relationships?.review_draft as {
    action?: string;
    merge_item_id?: string | null;
    merge_fields?: ImportDecision["mergeFields"];
    allow_duplicate?: boolean;
    entity_type?: ImportDecision["entityType"];
    parent_entry_id?: string | null;
    legacy_identifier?: string | null;
  } | undefined;
  if (!draft || typeof draft !== "object") return {};
  return {
    action: draft.action === "merge" ? "merge" : "import",
    mergeItemId: draft.merge_item_id ?? "",
    mergeFields: Array.isArray(draft.merge_fields) ? draft.merge_fields : [],
    allowDuplicate: Boolean(draft.allow_duplicate),
    ...(draft.entity_type ? { entityType: draft.entity_type } : {}),
    ...("parent_entry_id" in draft ? { parentEntryId: draft.parent_entry_id ?? null } : {}),
    ...("legacy_identifier" in draft ? { legacyIdentifier: draft.legacy_identifier ?? null } : {}),
  };
}

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
  // Messages from the last attempt to accept a row. They sit beside their fields.
  const [errors, setErrors] = React.useState<Record<string, ImportEntryErrors>>({});
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(new Set());
  // The finding that is pointed at, from its row or from its pin on the photo.
  const [activeFinding, setActiveFinding] = React.useState<string | null>(null);
  // Corrections of waiting rows are kept on the server by themselves. These hold what
  // the server has for each row as far as this page knows, the state that was last
  // compared, and each proposal as it was loaded.
  const autosave = useDraftAutosave({ kind: "import", id: batchId });
  const savedDrafts = React.useRef(new Map<string, string>());
  const comparedDrafts = React.useRef(
    new Map<string, { proposed: ProposedItem; decision: ImportDecision }>(),
  );
  const loadedDrafts = React.useRef(
    new Map<string, { proposed: ProposedItem; edited: EditableField[] }>(),
  );
  // What the server has for each row, as far as this page knows: taken when a row is
  // first corrected here, and from the answer of the server to each save after that.
  const serverRows = React.useRef(new Map<string, unknown>());
  // Rows whose decision is on its way, and rows that were decided here. Neither has a
  // draft to keep: the decision carried it.
  const decidingRows = React.useRef(new Set<string>());
  const decidedRows = React.useRef(new Set<string>());

  React.useEffect(() => {
    setSummary(null);
    setErrors({});
  }, [batchId]);

  const batch = batchQuery.data;
  const recovered = autosave.recovered;
  const forgetDraft = autosave.forget;
  React.useEffect(() => {
    if (!batch || batch.id !== batchId || initialized) return;
    if (batch.status !== "review" && batch.status !== "completed") return;
    const savedDraft = getImportReviewDraft(batchId);
    const nextEdits = { ...(savedDraft?.edits ?? {}) };
    for (const entry of batch.entries) {
      if (!(entry.id in nextEdits)) nextEdits[entry.id] = entry.proposed;
    }
    const nextDecisions = { ...(savedDraft?.decisions ?? {}) };
    const hierarchy = batch.metadata.hierarchy === true;
    const duplicateThreshold = hierarchy ? 55 : 70;
    comparedDrafts.current = new Map();
    for (const entry of batch.entries) {
      const highDuplicate = entry.duplicate_candidates.find(
        (candidate) => candidate.score >= duplicateThreshold,
      );
      const done = entry.status === "imported" || entry.status === "merged";
      const skippedNow = entry.status === "skipped" || entry.status === "rejected";
      // The choices that were kept with the row: what to do, and with which target.
      // They come back for a skipped row and for a row that still waits.
      const kept = reviewDraftOf(entry);
      const keptFields = keptEditedFields(entry);
      // The proposal as this page saw it first. What is changed by hand is told from it.
      if (!loadedDrafts.current.has(entry.id)) {
        loadedDrafts.current.set(entry.id, { proposed: entry.proposed, edited: keptFields });
      }
      // The draft this page would send for the row as the server has it.
      const serverBody = importDraftBody(entry, entry.proposed, {
        include: false,
        action: "import",
        mergeItemId: highDuplicate?.item_id ?? "",
        mergeFields: highDuplicate ? ["serial_number"] : [],
        ...kept,
      }, hierarchy, keptFields);
      // A correction of an earlier visit can still be on this device: its request was
      // lost, or it arrived but the page was gone before the answer. It is used only
      // when nobody else changed the row since: the server still has the row as it
      // was when the correction was made, or it has a draft that this browser sent
      // itself and never got an answer for. Then the copy is shown in its row again
      // and sent again below, as any correction made here. When the server has
      // something else (a newer correction from another device), the server wins
      // and the copy is removed. Nothing is decided by it. A draft of this visit
      // wins over it.
      const local = recovered.get(entry.id);
      if (local) {
        recovered.delete(entry.id);
        const body = local.body as Partial<ReturnType<typeof importDraftBody>> | null;
        const fromServer = stableJson(plainForm(serverBody));
        const ours = stableJson(serverRow(entry)) === stableJson(local.base) ||
          local.sent.some((sent) => stableJson(plainForm(sent)) === fromServer);
        const usable = waits(entry) && body && typeof body === "object" && body.proposed &&
          typeof body.proposed.name === "string" && typeof body.proposed.quantity === "number" && ours;
        if (!usable) {
          forgetDraft(entry.id);
        } else if (!savedDraft) {
          nextEdits[entry.id] = body.proposed as ProposedItem;
          nextDecisions[entry.id] = {
            include: false,
            action: body.action === "merge" ? "merge" : "import",
            mergeItemId: body.merge_item_id ?? "",
            mergeFields: Array.isArray(body.merge_fields) ? body.merge_fields : [],
            ...(body.entity_type ? { entityType: body.entity_type } : {}),
            ...("parent_entry_id" in body ? { parentEntryId: body.parent_entry_id ?? null } : {}),
            ...("legacy_identifier" in body ? { legacyIdentifier: body.legacy_identifier ?? null } : {}),
            ...("allow_duplicate" in body ? { allowDuplicate: Boolean(body.allow_duplicate) } : {}),
          };
          const named = Array.isArray(body.edited_fields) ? body.edited_fields : [];
          loadedDrafts.current.set(entry.id, {
            proposed: entry.proposed,
            edited: EDITABLE_FIELDS.filter((field) => keptFields.includes(field) || named.includes(field)),
          });
          // It is always sent again, also when the server may already have it: only
          // the answer of the server removes the copy from this device.
          savedDrafts.current.set(entry.id, "");
        }
      }
      if (waits(entry) && !savedDrafts.current.has(entry.id)) {
        // What the server holds for this row, the first time this page sees it. A
        // draft of this page that says something else (it was made here) is sent.
        // Later, only a row that was changed here since its last save is sent, so
        // that a row another tab corrected in the meantime is not overwritten.
        savedDrafts.current.set(entry.id, JSON.stringify(serverBody));
      }
      if (done) {
        nextDecisions[entry.id] = {
          include: false,
          action: "import",
          mergeItemId: entry.matched_item_id ?? "",
          mergeFields: [],
        };
      } else if (skippedNow) {
        // A skipped row keeps its whole draft. Restore brings it back as it was.
        nextDecisions[entry.id] = {
          action: "import",
          mergeItemId: "",
          mergeFields: [],
          ...nextDecisions[entry.id],
          ...kept,
          include: false,
        };
      } else if (!(entry.id in nextDecisions)) {
        // A review starts with nothing selected. A failed row keeps what it had, so
        // it stays selected and can be corrected and tried again.
        nextDecisions[entry.id] = {
          include: false,
          action: "import",
          mergeItemId: highDuplicate?.item_id ?? "",
          mergeFields: highDuplicate ? ["serial_number"] : [],
          ...kept,
        };
      } else if (nextDecisions[entry.id]?.action === "skip" || nextDecisions[entry.id]?.action === "reject") {
        // A restored row comes back open and not selected.
        nextDecisions[entry.id] = { ...nextDecisions[entry.id]!, include: false, action: "import" };
      }
    }
    // A copy for a row that is not in this import any more has nothing to go back to.
    for (const row of recovered.keys()) forgetDraft(row);
    recovered.clear();
    setEdits(nextEdits);
    setDecisions(nextDecisions);
    setInitializedBatchId(batchId);
  }, [batch, batchId, forgetDraft, getImportReviewDraft, initialized, recovered]);

  React.useEffect(() => {
    if (!initialized || !batch || batch.id !== batchId) return;
    saveImportReviewDraft(batchId, { edits, decisions });
  }, [batch, batchId, decisions, edits, initialized, saveImportReviewDraft]);

  // Keeps the corrections of waiting rows on the server, a short moment after the
  // last change of a row. Only a row whose draft differs from what the server has is
  // sent, with its whole draft. A row that is being added or skipped right now is
  // left alone: that request carries the draft itself.
  const saveDraft = autosave.save;
  React.useEffect(() => {
    if (!initialized || !batch || batch.id !== batchId || batch.status !== "review") return;
    const hierarchy = batch.metadata.hierarchy === true;
    for (const entry of batch.entries) {
      if (!waits(entry) || pendingIds.has(entry.id)) continue;
      if (decidingRows.current.has(entry.id) || decidedRows.current.has(entry.id)) continue;
      const proposed = edits[entry.id];
      const decision = decisions[entry.id];
      if (!proposed || !decision) continue;
      const compared = comparedDrafts.current.get(entry.id);
      if (compared && compared.proposed === proposed && compared.decision === decision) continue;
      comparedDrafts.current.set(entry.id, { proposed, decision });
      const loaded = loadedDrafts.current.get(entry.id);
      const body = importDraftBody(entry, proposed, decision, hierarchy,
        editedFields(loaded?.proposed ?? entry.proposed, loaded?.edited ?? [], proposed));
      const text = JSON.stringify(body);
      if (savedDrafts.current.get(entry.id) === text) continue;
      savedDrafts.current.set(entry.id, text);
      if (!serverRows.current.has(entry.id)) serverRows.current.set(entry.id, serverRow(entry));
      saveDraft(entry.id, {
        path: `/imports/${batchId}/entries/${entry.id}/draft`,
        body,
        base: serverRows.current.get(entry.id),
        // The answer is the row as the server has it now. The loaded import takes
        // it too, so that a review that opens later starts from what was confirmed
        // and not from an older row. The rows on screen are not set up again by it.
        rebase: (answer) => {
          const saved = answer as ImportEntry;
          const row = serverRow(saved);
          serverRows.current.set(entry.id, row);
          queryClient.setQueryData<ImportBatchDetail>(queryKeys.importBatch(batchId), (current) =>
            current && saved?.id === entry.id && current.entries.some((item) => item.id === saved.id && waits(item))
              ? { ...current, entries: current.entries.map((item) => item.id === saved.id ? saved : item) }
              : current);
          return row;
        },
      });
    }
  }, [batch, batchId, decisions, edits, initialized, pendingIds, queryClient, saveDraft]);

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
    mutationFn: async () => {
      // The server puts the suggestions under the corrections it has kept. So the
      // corrections that still wait are sent first.
      await autosave.settle();
      return {
        before: batch,
        after: await api.post<ImportBatchDetail>(`/imports/${batchId}/enhancement/accept`),
      };
    },
    onSuccess: ({ before, after }) => {
      const nextEdits = Object.fromEntries(after.entries.map((entry) => {
        const base = before?.entries.find((item) => item.id === entry.id);
        const edited = edits[entry.id];
        if (!base || !edited) return [entry.id, entry.proposed];
        // A field that was corrected in an earlier visit is a manual edit too. After
        // a reload it no longer differs from what was loaded, so it is named here.
        const loaded = loadedDrafts.current.get(entry.id);
        const earlier = Object.fromEntries(
          editedFields(loaded?.proposed ?? base.proposed, loaded?.edited ?? [], edited)
            .map((field) => [field, edited[field]]),
        );
        return [entry.id, { ...keepManualEdits(base.proposed, edited, entry.proposed), ...earlier }];
      }));
      setEdits(nextEdits);
      saveImportReviewDraft(batchId, { edits: nextEdits, decisions });
      // The server replaced the proposals. Every row is compared with it again, so
      // that the manual edits that were kept here are kept there too.
      savedDrafts.current = new Map();
      loadedDrafts.current = new Map();
      serverRows.current = new Map(after.entries.map((entry) => [entry.id, serverRow(entry)]));
      queryClient.setQueryData(queryKeys.importBatch(batchId), after);
      setInitializedBatchId("");
      toast.success("Suggestions loaded into review. Manual edits were kept; apply is still separate.");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const payloadFor = (id: string, forced?: "skip" | "reject") => {
    const hierarchy = batch?.metadata.hierarchy === true;
    const decision = decisions[id];
    const entry = batch?.entries.find((candidate) => candidate.id === id);
    const action = forced ?? (decision?.action === "merge" ? "merge" : "import");
    // A row can be skipped while its quantity field is empty. Its last real value is kept.
    const edited = edits[id];
    const proposed = edited && forced && !Number.isInteger(edited.quantity)
      ? { ...edited, quantity: entry?.proposed.quantity ?? 1 }
      : edited;
    // The chosen action and its target go with a skip too, so that the server keeps
    // the complete draft of the row.
    const mergeChoice = decision?.action === "merge"
      ? { merge_item_id: decision.mergeItemId || null, merge_fields: decision.mergeFields }
      : {};
    // A skipped row also keeps which fields were changed by hand.
    const loaded = loadedDrafts.current.get(id);
    const manual = forced && edited && entry
      ? { edited_fields: editedFields(loaded?.proposed ?? entry.proposed, loaded?.edited ?? [], edited) }
      : {};
    if (action === "merge" && decision) {
      return { id, action, proposed, ...mergeChoice };
    }
    return {
      id,
      action,
      proposed,
      ...(forced ? mergeChoice : {}),
      ...manual,
      ...(hierarchy
        ? {
            entity_type:
              decision?.entityType ??
              (entry?.entity_type as ImportDecision["entityType"]) ??
              "item",
            parent_entry_id:
              decision?.parentEntryId !== undefined
                ? decision.parentEntryId
                : (entry?.parent_entry_id ?? null),
            legacy_identifier:
              decision?.legacyIdentifier !== undefined
                ? decision.legacyIdentifier
                : (entry?.legacy_identifier ?? null),
            allow_duplicate: Boolean(decision?.allowDuplicate),
          }
        : {}),
    };
  };

  // One request serves a single row, a selection, a skip and a reject. The server
  // never adds a row twice: an added row is passed over when it is sent again.
  const apply = useMutation({
    mutationFn: ({ ids, forced }: { ids: string[]; forced?: "skip" | "reject" }) => {
      if (ids.length === 0) throw new Error("Select at least one row.");
      return api.post<ImportApplyResult>(`/imports/${batchId}/apply`, {
        entries: ids.map((id) => payloadFor(id, forced)),
      });
    },
    onMutate: ({ ids }) => {
      // This request carries the draft of these rows. A draft that still waits to be
      // kept is dropped.
      for (const id of ids) {
        decidingRows.current.add(id);
        autosave.cancel(id);
      }
      setPendingIds(new Set(ids));
    },
    onSettled: (_result, _error, { ids }) => {
      // A row that was not decided after all (the request failed, or the server could
      // not add it) is compared again, so that its corrections are kept.
      for (const id of ids) {
        decidingRows.current.delete(id);
        savedDrafts.current.delete(id);
        comparedDrafts.current.delete(id);
      }
      setPendingIds(new Set());
    },
    onSuccess: (result, { ids, forced }) => {
      const failedIds = new Set(result.failures.map((failure) => failure.entry_id));
      // Rows that were saved leave the selection. Rows that failed stay selected.
      const next = { ...decisions };
      for (const id of ids) {
        if (!failedIds.has(id)) {
          decidedRows.current.add(id);
          // The decision went through, so the copy on this device is not needed.
          autosave.forget(id);
        }
        if (!failedIds.has(id) && next[id]) next[id] = { ...next[id]!, include: false };
      }
      setDecisions(next);
      // The review is set up again from this draft, so it must be saved first.
      saveImportReviewDraft(batchId, { edits, decisions: next });
      setInitializedBatchId("");
      queryClient.setQueryData(queryKeys.importBatch(batchId), result.batch);
      invalidate();
      if (forced) {
        const names = ids.map((id) => edits[id]?.name || "Row").join(", ");
        toast.success(forced === "reject" ? `Rejected ${names}` : `Skipped ${names}`, {
          description: "Nothing was added. Its edits are kept.",
          action: ids.length === 1
            ? { label: "Undo", onClick: () => restore.mutate(ids[0]!) }
            : undefined,
        });
        return;
      }
      if (ids.length > 1 || result.failed) setSummary(result);
      const parts = [
        result.created ? `${pluralize(result.created, "item")} added` : null,
        result.merged ? `${pluralize(result.merged, "item")} updated` : null,
        result.failed ? `${result.failed} failed and stay selected` : null,
      ].filter(Boolean);
      if (result.failed) toast.warning(parts.join(" · "));
      else toast.success(parts.join(" · ") || "Nothing new to add. These rows were already saved.");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const restore = useMutation({
    mutationFn: (entryId: string) =>
      api.post<ImportBatchDetail>(`/imports/${batchId}/entries/${entryId}/restore`),
    onSuccess: (restored, entryId) => {
      // The row waits again, so its corrections are kept again from now on.
      decidedRows.current.delete(entryId);
      const row = restored.entries.find((entry) => entry.id === entryId);
      if (row) serverRows.current.set(entryId, serverRow(row));
      setInitializedBatchId("");
      queryClient.setQueryData(queryKeys.importBatch(batchId), restored);
      invalidate();
      toast.success("Restored. The row is back in the list.");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  // Checks the rows before anything is sent. A row with a problem is not sent; its
  // message is shown beside the field, and the row stays selected.
  const accept = (ids: string[]) => {
    if (apply.isPending) return;
    const hierarchy = batch?.metadata.hierarchy === true;
    const found: Record<string, ImportEntryErrors> = {};
    const valid: string[] = [];
    for (const id of ids) {
      const proposed = edits[id];
      const decision = decisions[id];
      if (!proposed || !decision) continue;
      const entryErrors = hierarchy
        ? (proposed.name.trim() ? {} : { name: "Give this record a name." })
        : validateImportEntry(proposed, decision);
      if (hasImportEntryErrors(entryErrors)) found[id] = entryErrors;
      else valid.push(id);
    }
    setErrors((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return { ...next, ...found };
    });
    const blocked = Object.keys(found).length;
    if (blocked) {
      toast.error(
        `${pluralize(blocked, "row")} ${blocked === 1 ? "needs" : "need"} a correction. Look for the marked field.`,
      );
    }
    if (valid.length) apply.mutate({ ids: valid });
  };

  const clearErrors = (entryId: string) =>
    setErrors((current) => {
      if (!(entryId in current)) return current;
      const next = { ...current };
      delete next[entryId];
      return next;
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.locationsAll });
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
  // The findings of a photo are numbered in the order the server gives them. The
  // number stays the same when another row is skipped.
  const photoReview = !hierarchyMode && typeof batch.metadata.recognition_id === "string";
  const findingNumbers = new Map(batch.entries.map((entry, index) => [entry.id, index + 1]));
  const shownEntries = batch.entries.filter(
    (entry) => entry.status !== "skipped" && entry.status !== "rejected",
  );
  const findingRowId = (entryId: string) => `finding-${entryId}`;
  const isOpen = (entry: ImportEntry) => entry.status === "proposed" || entry.status === "failed";
  const openEntries = batch.entries.filter(isOpen);
  const skippedEntries = batch.entries.filter(
    (entry) => entry.status === "skipped" || entry.status === "rejected",
  );
  const hasOpenEntries = openEntries.length > 0;
  // A checkbox only selects. Skip and Reject are their own actions, never a selection.
  const selectedIds = openEntries
    .filter((entry) => decisions[entry.id]?.include)
    .map((entry) => entry.id);
  const selectedCount = selectedIds.length;
  const updateIds = selectedIds.filter((id) => decisions[id]?.action === "merge");
  const addIds = selectedIds.filter((id) => decisions[id]?.action !== "merge");
  // A possible duplicate is left for the user to decide; Select all does not take it.
  const duplicateThreshold = hierarchyMode ? 55 : 70;
  const undecidedDuplicate = (entry: ImportEntry) =>
    !hierarchyMode &&
    decisions[entry.id]?.action !== "merge" &&
    entry.duplicate_candidates.some((candidate) => candidate.score >= duplicateThreshold);
  const selectable = openEntries.filter((entry) => !undecidedDuplicate(entry));
  const leftForYou = openEntries.length - selectable.length;
  const allSelected =
    selectable.length > 0 && selectable.every((entry) => decisions[entry.id]?.include);
  const noun = hierarchyMode ? "record" : "item";

  const setAll = (include: boolean) => {
    setDecisions((current) => {
      const next = { ...current };
      for (const entry of include ? selectable : openEntries) {
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

  const bulkButtons = (size: "sm" | "lg") => (
    <>
      {(addIds.length > 0 || updateIds.length === 0) && (
        <Button
          size={size}
          className={size === "lg" ? "min-h-11 shadow-lift" : "min-h-11 lg:min-h-9"}
          disabled={apply.isPending || acceptEnhancement.isPending || addIds.length === 0}
          onClick={() => accept(addIds)}
        >
          {apply.isPending ? <Spinner /> : <Check />}
          {addIds.length === 0
            ? `Add selected ${noun}s`
            : `Add ${addIds.length} selected ${addIds.length === 1 ? noun : `${noun}s`}`}
        </Button>
      )}
      {updateIds.length > 0 && (
        <Button
          size={size}
          variant={addIds.length > 0 ? "outline" : "default"}
          className={size === "lg" ? "min-h-11 shadow-lift" : "min-h-11 lg:min-h-9"}
          disabled={apply.isPending || acceptEnhancement.isPending}
          onClick={() => accept(updateIds)}
        >
          {apply.isPending ? <Spinner /> : <Check />}
          {`Apply ${updateIds.length} selected ${updateIds.length === 1 ? "change" : "changes"}`}
        </Button>
      )}
    </>
  );

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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-secondary/30 px-4 py-5 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {progress.message || "Processing this source in the background…"}
            </span>
            {batch.status === "processing" &&
              batch.metadata.assistant_capture === true &&
              batch.enhancement &&
              ["queued", "running"].includes(batch.enhancement.status) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => retryEnhancement.mutate("cancel")}
                  disabled={retryEnhancement.isPending}
                >
                  {retryEnhancement.isPending ? <Spinner /> : null}
                  Use local fallback
                </Button>
              )}
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
              ? "Housetory detected a room and container hierarchy. Expand branches, edit names, quantities, types and parents, then add the tree. Parents are created before their contents."
              : "Check each row. Nothing is added until you add it. Correct a name or a number in the row; open Edit for more."}
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
          {photoReview && (
            // Each finding has a number. A pin is drawn only where the recognition
            // gave a real position; the others are named honestly, without a pin.
            <FindingsPhoto
              className="mt-4"
              src={`/api/v1/ai/recognitions/${batch.metadata.recognition_id as string}/image`}
              alt="The photo these items were found in"
              findings={shownEntries.map((entry) => ({
                id: entry.id,
                number: findingNumbers.get(entry.id) ?? 0,
                name: (edits[entry.id] ?? entry.proposed).name,
                region: entry.source_region,
              }))}
              activeId={activeFinding}
              onPoint={setActiveFinding}
              onActivate={(id) => {
                setActiveFinding(id);
                const element = document.getElementById(findingRowId(id));
                element?.scrollIntoView?.({ block: "center" });
                element?.focus({ preventScroll: true });
              }}
            />
          )}
          {hasOpenEntries && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 lg:min-h-9"
                onClick={() => setAll(!allSelected)}
                disabled={apply.isPending || selectable.length === 0}
              >
                {allSelected ? "Clear selection" : "Select all"}
              </Button>
              <span className="text-xs text-muted-foreground" role="status">
                {selectedCount} selected
                {leftForYou > 0 && ` · ${pluralize(leftForYou, "possible duplicate")} left for you to decide`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">{bulkButtons("sm")}</div>
          </div>
          )}
          <DraftSaveNotice show={autosave.unsaved} className="mt-2 px-1 text-xs text-muted-foreground" />

          {hierarchyMode ? (
            <div className="mt-3">
              <HierarchyReview
                entries={batch.entries}
                edits={edits}
                decisions={decisions}
                disabled={apply.isPending || restore.isPending}
                onEdit={(entryId, proposed) => {
                  clearErrors(entryId);
                  setEdits((current) => ({ ...current, [entryId]: proposed }));
                }}
                onDecision={(entryId, decision) =>
                  setDecisions((current) => ({ ...current, [entryId]: decision }))
                }
                onAdd={(entryId) => accept([entryId])}
                onSkip={(entryId) => apply.mutate({ ids: [entryId], forced: "skip" })}
                onReject={(entryId) => apply.mutate({ ids: [entryId], forced: "reject" })}
                onRestore={(entryId) => restore.mutate(entryId)}
                pendingIds={pendingIds}
                nameErrors={Object.fromEntries(
                  Object.entries(errors).map(([id, entryErrors]) => [id, entryErrors.name]),
                )}
              />
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {shownEntries.map((entry: ImportEntry) => (
                <ImportEntryCard
                  key={entry.id}
                  entry={entry}
                  {...(photoReview ? {
                    rowId: findingRowId(entry.id),
                    number: findingNumbers.get(entry.id),
                    marked: activeFinding === entry.id,
                    onActivate: () => setActiveFinding(entry.id),
                  } : {})}
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
                  disabled={apply.isPending || restore.isPending}
                  errors={errors[entry.id]}
                  pending={pendingIds.has(entry.id)}
                  onProposedChange={(proposed) => {
                    clearErrors(entry.id);
                    setEdits((current) => ({ ...current, [entry.id]: proposed }));
                  }}
                  onDecisionChange={(decision) => {
                    clearErrors(entry.id);
                    setDecisions((current) => ({ ...current, [entry.id]: decision }));
                  }}
                  onCreateRoom={createRoom}
                  onCreateLocation={createLocation}
                  onAdd={() => accept([entry.id])}
                  onSkip={() => apply.mutate({ ids: [entry.id], forced: "skip" })}
                  onReject={() => apply.mutate({ ids: [entry.id], forced: "reject" })}
                />
              ))}
            </div>
          )}

          {skippedEntries.length > 0 && (
            <div className="mt-3">
              <SkippedSection count={skippedEntries.length}>
                {skippedEntries.map((entry) => (
                  <SkippedRow
                    key={entry.id}
                    title={(edits[entry.id] ?? entry.proposed).name || "Unnamed"}
                    detail={entry.status === "rejected" ? "Rejected" : undefined}
                    disabled={restore.isPending || apply.isPending}
                    onRestore={() => restore.mutate(entry.id)}
                  />
                ))}
              </SkippedSection>
            </div>
          )}

          {hasOpenEntries && selectedCount > 0 && (
            <div
              className="sticky z-20 mt-4 flex flex-wrap justify-end gap-2"
              style={{ bottom: embedded ? "0.5rem" : "calc(var(--shell-bar-height, 0px) + var(--keyboard-inset, 0px) + 0.75rem)" }}
            >
              {bulkButtons("lg")}
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
