import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Link2,
  PackagePlus,
  Search,
  Sparkles,
  Wand2,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api, getApiErrorMessage } from "@/lib/api";
import { CURRENCIES } from "@/lib/labels";
import {
  queryKeys,
  useCanWrite,
  useDefaultCurrency,
  useInvalidateInventory,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type {
  AiStatus,
  CandidateItem,
  DocumentCaptureContext,
  DocumentProcessing,
  DocumentRecord,
  ExtractionApplyResponse,
  ExtractionLineMatch,
  ExtractionMatchResponse,
  ExtractionRefinement,
  ExtractionReview,
  ItemListEntry,
} from "@/lib/types";
import { cn, formatCurrency, formatDate, pluralize } from "@/lib/utils";
import { MoreDetails, ReviewRow, SkippedRow, SkippedSection, type ReviewValue } from "@/components/review-row";
import {
  type ExtractionHeaderDraft,
  type ExtractionLineState,
  type ExtractionLineStates,
  type ExtractionReviewWithStates,
  type LineDraft,
  buildApplyPayload,
  lineDraftErrors,
  restoreLineDraft,
  savedCandidate,
  serializeLineDraft,
  serverHeader,
  serverLine,
  candidateFromItem,
  centsInput,
  fieldValue,
  lineDraft,
  parseQuantity,
  parseMoney,
  qualityLabel,
} from "@/components/document-extraction-helpers";
import { ItemSearchPicker } from "@/components/document-extraction-item-picker";
import { enhancementLabel } from "@/lib/enrichment";
import { stableJson } from "@/lib/review-draft-store";
import { DraftSaveNotice, useDraftAutosave } from "@/lib/review-drafts";

export function DocumentExtractionReview({ document, onOpenChange, manualReviewRequest = 0, captureContext, enabled = true }: {
  document: DocumentRecord;
  onOpenChange?: (open: boolean) => void;
  manualReviewRequest?: number;
  captureContext?: DocumentCaptureContext;
  enabled?: boolean;
}) {
  const canWrite = useCanWrite();
  const defaultCurrency = useDefaultCurrency();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const extractionQuery = useQuery({
    queryKey: [...queryKeys.document(document.id), "extraction"],
    queryFn: () => api.get<ExtractionReviewWithStates>(`/documents/${document.id}/extraction`),
    enabled: enabled && document.ocr_status === "succeeded" && Boolean(document.extracted_text),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.enhancement?.status ?? "") ? 1000 : false,
  });
  const processingKey = [...queryKeys.document(document.id), "processing"];
  const processingQuery = useQuery({
    queryKey: processingKey,
    queryFn: ({ signal }) => api.get<DocumentProcessing>(`/documents/${document.id}/processing`, { signal }),
    enabled: false,
  });
  const queueingRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const [opened, setOpened] = React.useState(false);
  const reviewId = React.useId();
  const roomsQuery = useRooms(undefined, opened && enabled);
  const locationsQuery = useLocations(undefined, opened && enabled);
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const [drafts, setDrafts] = React.useState<LineDraft[]>([]);
  const [matches, setMatches] = React.useState<ExtractionLineMatch[]>([]);
  const [manualLineId, setManualLineId] = React.useState<string | null>(null);
  const [merchant, setMerchant] = React.useState("");
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const [documentDate, setDocumentDate] = React.useState("");
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [total, setTotal] = React.useState("");
  const [orderNumber, setOrderNumber] = React.useState("");
  const [purchaseAction, setPurchaseAction] = React.useState<"none" | "create" | "existing">(
    "none",
  );
  const [purchaseId, setPurchaseId] = React.useState("");
  const [updatePurchaseFields, setUpdatePurchaseFields] = React.useState(false);
  const [attachAsReceipt, setAttachAsReceipt] = React.useState(true);
  const [linkDocument, setLinkDocument] = React.useState(true);
  const [allowReapply, setAllowReapply] = React.useState(false);
  const [aiStatus, setAiStatus] = React.useState<AiStatus | null>(null);
  const [aiWarnings, setAiWarnings] = React.useState<string[]>([]);
  // One request id for each set of lines, so that a retry of the same set is safe.
  const requestIds = React.useRef(new Map<string, string>());
  const [openLines, setOpenLines] = React.useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = React.useState<ReadonlySet<string>>(new Set());
  const [applyResult, setApplyResult] = React.useState<ExtractionApplyResponse | null>(null);
  const [activeVersion, setActiveVersion] = React.useState("");
  const [refinement, setRefinement] = React.useState<ExtractionRefinement | null>(null);
  const [activeRefinement, setActiveRefinement] = React.useState<ExtractionRefinement | null>(null);
  const refinementActive = activeRefinement != null;
  const versionRef = React.useRef<string | null>(null);
  const manualChosenRef = React.useRef(false);
  const editedRef = React.useRef(false);
  const [newVersionAvailable, setNewVersionAvailable] = React.useState(false);
  // Corrections of waiting lines are kept on the server by themselves. `savedLines`
  // holds what the server has for each line as far as this review knows. `loadCount`
  // goes up each time a review is loaded: those rows are the start, not a correction.
  //
  // A correction that the server never confirmed (the page was closed just then) is
  // still on this device. It is put back into its line, or into the fields at the
  // top, when the review is loaded, and sent again. `resend` names those.
  const autosave = useDraftAutosave({ kind: "document", id: document.id });
  const savedLines = React.useRef(new Map<string, string>());
  const [loadCount, setLoadCount] = React.useState(0);
  const startedFrom = React.useRef(0);
  const resend = React.useRef(new Set<string>());
  // The fields at the top are kept the same way, as one draft with the key "header".
  const savedHeader = React.useRef("");
  const firstHeader = React.useRef("");
  const headerStartedFrom = React.useRef(0);
  // What the server keeps for each line and for the fields at the top, as far as this
  // review knows: taken when one is first corrected here, and from the answer of the
  // server to each save after that. It goes with the copy on this device.
  const serverLines = React.useRef(new Map<string, unknown>());
  const serverFields = React.useRef<unknown>(undefined);
  const sourceData = extractionQuery.data;
  const data = sourceData && activeRefinement
    ? { ...sourceData, fields: activeRefinement.fields, lines: activeRefinement.lines,
        matches: activeRefinement.matches, warnings: activeRefinement.warnings,
        financial_validation: activeRefinement.financial_validation,
        version: activeRefinement.version, source_artifact: activeRefinement.source_artifact }
    : sourceData;
  const toggleReview = (next: boolean) => {
    setOpen(next);
    if (next) {
      manualChosenRef.current = true;
      setOpened(true);
    }
    onOpenChange?.(next);
  };

  const loadProposal = (
    fields: ExtractionReview["fields"],
    lines: ExtractionReview["lines"],
    proposalMatches: ExtractionLineMatch[],
    version: string,
    purchaseEligible: boolean,
  ) => {
    const matchMap = Object.fromEntries(
      proposalMatches.map((match) => [match.line_id, match]),
    );
    const productLines = lines.filter((line) => line.kind === "product");
    // What is kept for each line: by the server, or still on this device.
    const states: Record<string, ExtractionLineState | undefined> = {};
    for (const line of productLines) {
      const server = extractionQuery.data?.line_states?.[line.id];
      const local = autosave.recovered.get(line.id);
      states[line.id] = server;
      if (!local) continue;
      autosave.recovered.delete(line.id);
      const body = local.body as Partial<ExtractionLineState> | null;
      // The copy is used only when nobody else changed the line since: the server
      // still has what it had when the correction was made, or it has a draft that
      // this browser sent itself and never got an answer for. A line that was
      // decided, or that the server has something else for (a newer correction from
      // another device), keeps what the server has, and the copy is removed. What
      // this page wrote into the loaded review itself, unconfirmed, is not from the
      // server.
      const now = stableJson(serverLine(server));
      const unchanged = server?.unconfirmed === true || now === stableJson(local.base) ||
        local.sent.some((sent) => stableJson(serverLine(sent as ExtractionLineState)) === now);
      if (server?.status === "applied" || server?.status === "skipped" ||
          !body || typeof body !== "object" || !unchanged) {
        autosave.forget(line.id);
        continue;
      }
      states[line.id] = { ...body, status: "pending" };
      resend.current.add(line.id);
    }
    const loaded = productLines.map((line) => {
      const draft = lineDraft(
        line,
        matchMap[line.id]?.candidates[0],
        fields,
        productLines.length === 1,
      );
      // A line that was skipped comes back with the complete draft it had then:
      // amounts, action and target, new item, updates, stock and warranty.
      const state = states[line.id];
      const kept = restoreLineDraft(draft, state);
      if (captureContext?.documentId !== document.id) return kept;
      // The place chosen at capture is only a start. A place that was changed on
      // the row and kept with a skip wins over it.
      const keptPlace = state && state.status !== "applied"
        && Boolean((state.draft as { newItem?: unknown } | null | undefined)?.newItem);
      if (keptPlace) return kept;
      return { ...kept, newItem: { ...kept.newItem,
        roomId: captureContext.roomId, locationId: captureContext.roomId ? captureContext.locationId : "" } };
    });
    setLoadCount((count) => count + 1);
    setDrafts(loaded);
    // A line that came back with a kept correction counts as edited: suggestions that
    // arrive later must not replace it without the person asking for them.
    if (productLines.some((line) => {
      const state = states[line.id];
      return state?.status === "pending" && Boolean(state.draft);
    })) editedRef.current = true;
    // An item that was chosen by hand is not among the proposed matches after a
    // reload. It was kept with the draft, so the row can still name its target.
    setMatches(productLines.reduce((all, line) => {
      const candidate = savedCandidate(states[line.id]);
      if (!candidate) return all;
      const existing = all.find((match) => match.line_id === line.id);
      if (existing?.candidates.some((entry) => entry.id === candidate.id)) return all;
      return existing
        ? all.map((match) => match === existing
          ? { ...match, candidates: [candidate, ...match.candidates] } : match)
        : [...all, { line_id: line.id, candidates: [candidate], quality: "possible" as const, reasons: candidate.reasons ?? [] }];
    }, proposalMatches));
    // The fields at the top start from the first reading. A kept correction of them,
    // for this same version, goes on top: from this device when the server never
    // confirmed it, else from the server. This only fills the fields. Nothing is applied.
    const first: Required<ExtractionHeaderDraft> = {
      merchant: fieldValue(fields.merchant ?? document.merchant),
      purchase_date: fieldValue(fields.purchase_date),
      document_date: fieldValue(fields.document_date ?? document.document_date),
      currency: fields.currency ?? defaultCurrency,
      total: centsInput(fields.total_cents),
      order_number: fieldValue(fields.order_number),
      purchase_action: purchaseEligible && fields.total_cents != null ? "create" : "none",
    };
    const localHeader = autosave.recovered.get("header");
    const localBody = localHeader?.body as
      { version?: string; draft?: ExtractionHeaderDraft | null } | null | undefined;
    const keptHeader = extractionQuery.data?.header_draft;
    let kept: ExtractionHeaderDraft | null = keptHeader?.version === version ? keptHeader.draft : null;
    if (localHeader && localBody && typeof localBody === "object" && localBody.version === version) {
      autosave.recovered.delete("header");
      // The same rule as for a line: the copy is used only when the server still has
      // what it had when the fields were corrected, or what this browser sent itself
      // without getting an answer. Otherwise the server wins.
      const now = stableJson(serverHeader(keptHeader));
      const sentHeader = (sent: unknown) => {
        const body = sent as { version?: string; draft?: ExtractionHeaderDraft | null } | null;
        return body?.draft && body.version ? serverHeader({ version: body.version, draft: body.draft }) : null;
      };
      if (extractionQuery.data?.header_unconfirmed === true || now === stableJson(localHeader.base) ||
          localHeader.sent.some((sent) => stableJson(sentHeader(sent)) === now)) {
        kept = localBody.draft ?? {};
        resend.current.add("header");
      } else {
        autosave.forget("header");
      }
    }
    const text = (value: string | null | undefined, fallback: string | null) =>
      typeof value === "string" ? value : fallback ?? "";
    setMerchant(text(kept?.merchant, first.merchant));
    setPurchaseDate(text(kept?.purchase_date, first.purchase_date));
    setDocumentDate(text(kept?.document_date, first.document_date));
    setCurrency(text(kept?.currency, first.currency));
    setTotal(text(kept?.total, first.total));
    setOrderNumber(text(kept?.order_number, first.order_number));
    setPurchaseAction(
      kept?.purchase_action === "none" || (kept?.purchase_action === "create" && purchaseEligible)
        ? kept.purchase_action : first.purchase_action ?? "none",
    );
    firstHeader.current = JSON.stringify(first);
    if (kept) editedRef.current = true;
    setPurchaseId("");
    setUpdatePurchaseFields(false);
    setAttachAsReceipt(true);
    setLinkDocument(true);
    setAllowReapply(false);
    setActiveVersion(version);
    setApplyResult(null);
    setManualLineId(null);
    requestIds.current.clear();
    // A line that is still there stays open; nothing else is carried over.
    setOpenLines((current) => new Set(
      [...current].filter((id) => productLines.some((line) => line.id === id)),
    ));
    setAttempted(new Set());
  };

  React.useEffect(() => {
    if (!sourceData || versionRef.current === sourceData.version) return;
    if (editedRef.current) {
      setNewVersionAvailable(true);
      return;
    }
    versionRef.current = sourceData.version;
    loadProposal(
      sourceData.fields,
      sourceData.lines,
      sourceData.matches,
      sourceData.version,
      sourceData.purchase_eligible,
    );
    setAiStatus(sourceData.ai_status);
    setAiWarnings([]);
    setRefinement(null);
    setActiveRefinement(null);
    // The proposal identity intentionally resets drafts only for a new OCR version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceData]);

  React.useEffect(() => {
    const suggested = sourceData?.suggested_refinement;
    if (!suggested || !sourceData || !suggested.ai_used ||
      suggested.base_version !== sourceData.version ||
      manualChosenRef.current || editedRef.current ||
      sourceData.enhancement?.status !== "ready") return;
    loadProposal(suggested.fields, suggested.lines, suggested.matches,
      suggested.version, sourceData.purchase_eligible);
    setRefinement(null);
    setActiveRefinement(suggested);
    // Only an untouched, unopened draft can adopt background suggestions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceData]);

  React.useEffect(() => {
    if (!manualReviewRequest) return;
    if (refinementActive && sourceData && !editedRef.current) {
      loadProposal(sourceData.fields, sourceData.lines, sourceData.matches,
        sourceData.version, sourceData.purchase_eligible);
      setRefinement(null);
      setActiveRefinement(null);
    }
    toggleReview(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualReviewRequest]);

  const retryEnhancement = useMutation({
    mutationFn: (action: "cancel") => api.post<ExtractionReview>(
      `/documents/${document.id}/extraction/enhancement/${action}`,
    ),
    onSuccess: (result) => {
      queryClient.setQueryData([...queryKeys.document(document.id), "extraction"], result);
      if (result.enhancement?.reason === "cancelled") setRefinement(null);
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.document(document.id), "extraction"],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(document.id), exact: true });
      toast.success(result.enhancement?.status === "queued"
        ? "AI suggestions queued; local review stays available"
        : "AI suggestions cancelled; local review is unchanged");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const matchMutation = useMutation({
    mutationFn: () =>
      api.post<ExtractionMatchResponse>(
        `/documents/${document.id}/extraction/matches`,
        {
          use_ai: false,
          lines: drafts.map((draft) => ({
            line_id: draft.line.id,
            description: draft.description.trim() || draft.line.description,
            quantity: parseQuantity(draft.quantity),
            brand: drafts.length === 1 ? data?.fields.brand : undefined,
            model: drafts.length === 1 ? data?.fields.model : undefined,
            serial_numbers: drafts.length === 1 ? data?.fields.serial_numbers : [],
          })),
        },
      ),
    onSuccess: (result) => {
      setMatches(result.matches);
      setAiStatus(result.ai_status);
      setAiWarnings(result.warnings);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const queueAi = useMutation({
    mutationFn: async (operation: "interpret" | "matches") => {
      await queryClient.cancelQueries({ queryKey: processingKey, exact: true });
      return api.post<DocumentProcessing>(`/documents/${document.id}/processing/retry`, { operation });
    },
    onSuccess: (snapshot) => {
      const current = queryClient.getQueryData<DocumentProcessing>(processingKey);
      const activeStages = ["waiting", "reading", "interpreting"];
      const newerTerminal = current?.correlation_id === snapshot.correlation_id &&
        !activeStages.includes(current.stage) &&
        Date.parse(current.updated_at) >= Date.parse(snapshot.updated_at);
      if (!newerTerminal) queryClient.setQueryData(processingKey, snapshot);
      void queryClient.invalidateQueries({ queryKey: processingKey, exact: true });
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.document(document.id), "extraction"],
      });
      if (!newerTerminal && activeStages.includes(snapshot.stage)) {
        toast.message("AI review queued; your current draft stays unchanged");
      }
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
    onSettled: () => { queueingRef.current = false; },
  });
  const aiProcessing = queueAi.isPending ||
    ["waiting", "reading", "interpreting"].includes(processingQuery.data?.stage ?? "") ||
    ["queued", "running"].includes(sourceData?.enhancement?.status ?? "");
  const queueOperation = (operation: "interpret" | "matches") => {
    if (queueingRef.current || aiProcessing || matchMutation.isPending) return;
    queueingRef.current = true;
    queueAi.mutate(operation);
  };

  const extractionKey = [...queryKeys.document(document.id), "extraction"];
  // Applies the given lines only. The other lines stay pending. The server keeps the
  // parts of one document on one purchase and never applies a line twice.
  const applyMutation = useMutation({
    mutationFn: (lineIds: string[]) => {
      const key = [...lineIds].sort().join(",");
      const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
      requestIds.current.set(key, requestId);
      return api.post<ExtractionApplyResponse>(
        `/documents/${document.id}/extraction/apply`,
        buildApplyPayload({
          extractionVersion: activeVersion,
          drafts: drafts.filter((draft) => lineIds.includes(draft.line.id)),
          merchant, purchaseDate, documentDate, currency, total, orderNumber,
          // A purchase needs at least one item. Without lines only the details are saved.
          purchaseAction: lineIds.length ? purchaseAction : "none",
          purchaseId, updatePurchaseFields, attachAsReceipt, linkDocument, allowReapply, requestId,
        }),
      );
    },
    onMutate: (lineIds) => {
      // The apply carries the values of these lines. A draft that still waits is dropped.
      for (const id of lineIds) autosave.cancel(id);
    },
    onSuccess: (result, lineIds) => {
      // The lines are applied, so their copies on this device are not needed.
      for (const id of lineIds) autosave.forget(id);
      requestIds.current.delete([...lineIds].sort().join(","));
      setApplyResult(result);
      setAllowReapply(false);
      setDrafts((current) => current.map((draft) =>
        lineIds.includes(draft.line.id) ? { ...draft, selected: false } : draft));
      // The applied lines are finished at once, before the refreshed review arrives.
      queryClient.setQueryData<ExtractionReviewWithStates>(extractionKey, (current) => current && ({
        ...current,
        applied_version: current.applied_version ?? activeVersion,
        line_states: {
          ...current.line_states,
          ...Object.fromEntries(lineIds.map((id) => [id, {
            status: "applied" as const,
            action: drafts.find((draft) => draft.line.id === id)?.action as "create" | "update" | "link",
          }])),
        },
      }));
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.document(document.id), "extraction"],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      toast.success("Reviewed extraction applied");
    },
    onError: (error, lineIds) => {
      // Nothing was applied, so the lines still wait. Their corrections are kept again.
      for (const id of lineIds) savedLines.current.delete(id);
      toast.error(getApiErrorMessage(error));
    },
  });

  // The whole row as the server keeps it, with a skip and for a line that still waits:
  // the values of the row and its complete draft, with the item it points to.
  const keptBody = (draft: LineDraft) => ({
    description: draft.description.trim().slice(0, 300) || null,
    quantity: parseQuantity(draft.quantity),
    line_total_cents: parseMoney(draft.lineTotal),
    draft: serializeLineDraft(
      draft,
      matches.find((match) => match.line_id === draft.line.id)
        ?.candidates.find((candidate) => candidate.id === draft.itemId),
    ),
  });

  // What two drafts are compared by. The chosen item counts by its id only: fresh
  // match details of the same item are not a correction.
  const keptText = (body: ReturnType<typeof keptBody>) => {
    const candidate = body.draft.candidate as { id?: string } | undefined;
    return JSON.stringify({ ...body, draft: { ...body.draft, candidate: candidate?.id ?? null } });
  };

  // Skip is remembered by the server, so a skipped line does not come back by itself.
  const skipMutation = useMutation({
    mutationFn: ({ draft, restore }: { draft: LineDraft; restore: boolean }) =>
      api.post<ExtractionLineStates>(
        `/documents/${document.id}/extraction/lines/${draft.line.id}/${restore ? "restore" : "skip"}`,
        // The whole row, so that a reload and Restore bring all of it back.
        restore ? undefined : keptBody(draft),
      ),
    onMutate: ({ draft, restore }) => {
      autosave.cancel(draft.line.id);
      // The skip carries the draft itself, so the server has it when the skip goes through.
      if (!restore) savedLines.current.set(draft.line.id, keptText(keptBody(draft)));
    },
    onError: (error, { draft, restore }) => {
      if (!restore) savedLines.current.delete(draft.line.id);
      toast.error(getApiErrorMessage(error));
    },
    onSuccess: (result, { draft, restore }) => {
      // The skip carried the draft, so the copy on this device is not needed.
      if (!restore) autosave.forget(draft.line.id);
      queryClient.setQueryData<ExtractionReviewWithStates>(extractionKey, (current) =>
        current && ({ ...current, ...result }));
      setDrafts((current) => current.map((entry) =>
        entry.line.id === draft.line.id ? { ...entry, selected: false } : entry));
      if (restore) {
        toast.success("Restored. The line is back in the list.");
        return;
      }
      toast.success(`Skipped: ${draft.description || "line"}`, {
        description: "Nothing was added. Its edits are kept.",
        action: { label: "Undo", onClick: () => skipMutation.mutate({ draft, restore: true }) },
      });
    },
  });

  // Keeps the corrections of waiting lines on the server, a short moment after the
  // last change of a line. Only a line that differs from what the server has is sent,
  // with its whole draft. A line that is applied or skipped has no draft to keep, and
  // a line that is being applied or skipped right now is left to that request.
  const saveDraft = autosave.save;
  const keptStates = extractionQuery.data?.line_states;
  const applyingLines = applyMutation.isPending ? applyMutation.variables : undefined;
  const skippingLine = skipMutation.isPending ? skipMutation.variables?.draft.line.id : undefined;
  React.useEffect(() => {
    if (!canWrite) return;
    // The rows of a review that was just loaded are the start for every line.
    const start = startedFrom.current !== loadCount;
    startedFrom.current = loadCount;
    if (start) {
      savedLines.current = new Map();
      serverLines.current = new Map();
    }
    const changed: Record<string, ExtractionLineState> = {};
    for (const draft of drafts) {
      const id = draft.line.id;
      const status = keptStates?.[id]?.status;
      if (status === "applied" || status === "skipped") continue;
      if (applyingLines?.includes(id) || skippingLine === id) continue;
      const body = keptBody(draft);
      const text = keptText(body);
      // A line that was put back from this device is not on the server yet: it is sent.
      if (start && !resend.current.delete(id)) {
        savedLines.current.set(id, text);
        continue;
      }
      if (savedLines.current.get(id) === text) continue;
      savedLines.current.set(id, text);
      if (!serverLines.current.has(id)) serverLines.current.set(id, serverLine(keptStates?.[id]));
      saveDraft(id, {
        path: `/documents/${document.id}/extraction/lines/${encodeURIComponent(id)}/draft`,
        body,
        base: serverLines.current.get(id),
        // The answer has the line as the server keeps it now. The loaded review
        // takes it in place of what this page wrote there, if that is still the same.
        rebase: (answer) => {
          const state = (answer as Partial<ExtractionLineStates> | null)?.line_states?.[id];
          const kept = serverLine(state);
          serverLines.current.set(id, kept);
          queryClient.setQueryData<ExtractionReviewWithStates>(
            [...queryKeys.document(document.id), "extraction"],
            (current) => current && state &&
              stableJson(serverLine(current.line_states?.[id])) === stableJson(kept)
              ? { ...current, line_states: { ...current.line_states, [id]: state } } : current,
          );
          return kept;
        },
      });
      changed[id] = { status: "pending", ...body, unconfirmed: true };
    }
    // The loaded review remembers the draft at once, so that coming back to this
    // document shows the corrections without waiting for the server. The rows on
    // screen are not touched by this: they are set up only when a review is loaded.
    if (Object.keys(changed).length) {
      queryClient.setQueryData<ExtractionReviewWithStates>(
        [...queryKeys.document(document.id), "extraction"],
        (current) => current && ({ ...current, line_states: { ...current.line_states, ...changed } }),
      );
    }
    // `keptBody` and `keptText` read only the rows and the matches, which are both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyingLines, canWrite, document.id, drafts, keptStates, loadCount, matches, queryClient, saveDraft, skippingLine]);

  // The fields at the top are kept like a line: the whole set, a short moment after
  // the last change, for the version that is on screen. When they are the first
  // reading again, the kept draft is removed. Keeping them applies nothing.
  React.useEffect(() => {
    if (!canWrite || !activeVersion) return;
    const start = headerStartedFrom.current !== loadCount;
    headerStartedFrom.current = loadCount;
    if (start) serverFields.current = undefined;
    const draft: Required<ExtractionHeaderDraft> = {
      merchant: merchant.slice(0, 200),
      purchase_date: purchaseDate.slice(0, 40),
      document_date: documentDate.slice(0, 40),
      currency: currency.slice(0, 8),
      total: total.slice(0, 40),
      order_number: orderNumber.slice(0, 120),
      // An existing purchase is chosen from the matched items, so it is not kept.
      purchase_action: purchaseAction === "existing" ? null : purchaseAction,
    };
    const text = JSON.stringify(draft);
    if (start && !resend.current.delete("header")) {
      savedHeader.current = text;
      return;
    }
    if (savedHeader.current === text) return;
    savedHeader.current = text;
    const unchanged = text === firstHeader.current;
    const reviewKey = [...queryKeys.document(document.id), "extraction"];
    if (serverFields.current === undefined) {
      const loaded = queryClient.getQueryData<ExtractionReviewWithStates>(reviewKey);
      serverFields.current = serverHeader(loaded?.header_draft);
    }
    const optimistic = unchanged ? null : { version: activeVersion, draft };
    saveDraft("header", {
      path: `/documents/${document.id}/extraction/draft`,
      body: { version: activeVersion, draft: unchanged ? null : draft },
      base: serverFields.current,
      rebase: (answer) => {
        const kept = serverHeader((answer as ExtractionReviewWithStates | null)?.header_draft);
        serverFields.current = kept;
        queryClient.setQueryData<ExtractionReviewWithStates>(reviewKey, (current) =>
          current && stableJson(serverHeader(current.header_draft)) === stableJson(kept)
            ? { ...current, header_unconfirmed: false } : current);
        return kept;
      },
    });
    queryClient.setQueryData<ExtractionReviewWithStates>(
      reviewKey,
      (current) => current && ({ ...current, header_draft: optimistic, header_unconfirmed: true }),
    );
  }, [activeVersion, canWrite, currency, document.id, documentDate, loadCount, merchant,
    orderNumber, purchaseAction, purchaseDate, queryClient, saveDraft, total]);

  if (document.ocr_status === "queued" || document.ocr_status === "processing") {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/20 px-4 py-5 text-xs text-muted-foreground">
        Local evidence is not available yet. Follow processing above, or enter items manually.
      </div>
    );
  }
  if (extractionQuery.isPending && document.ocr_status === "succeeded" && document.extracted_text) {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/20 px-4 py-5 text-xs text-muted-foreground">
        <Spinner /> Preparing the line-item proposal…
      </div>
    );
  }
  if (extractionQuery.isError) {
    return (
      <div className="mt-5 rounded-xl border border-brass/25 bg-brass-soft/40 p-4 text-xs leading-relaxed text-muted-foreground">
        Extraction is not available yet. Retry OCR from the Local OCR panel after
        improving the scan, then review the proposal again.
      </div>
    );
  }
  if (!data) {
    return (
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        Run OCR to propose document fields and product lines. Nothing is applied until you
        confirm the reviewed proposal.
      </p>
    );
  }
  if (!canWrite) {
    return (
      <div className="mt-5 rounded-xl border border-border/70 bg-secondary/25 p-4 text-2xs leading-relaxed text-muted-foreground">
        Extracted fields and matches are visible to viewers for reference. Applying changes
        requires member access.
      </div>
    );
  }

  const charges = data.lines.filter((line) => line.kind !== "product");
  const selectedPurchaseIds = new Map<string, CandidateItem["purchase"]>();
  for (const draft of drafts) {
    if (draft.action === "create" || !draft.itemId) continue;
    const candidate = matches
      .find((match) => match.line_id === draft.line.id)
      ?.candidates.find((entry) => entry.id === draft.itemId);
    if (candidate?.purchase) selectedPurchaseIds.set(candidate.purchase.id, candidate.purchase);
  }
  const existingPurchases = [...selectedPurchaseIds.values()].filter(
    (purchase): purchase is NonNullable<typeof purchase> => purchase != null,
  );
  const purchaseOptions = existingPurchases.filter(
    (purchase, index, all) => all.findIndex((entry) => entry.id === purchase.id) === index,
  );

  const lineStates = data.line_states ?? {};
  // A deliberate re-apply opens the applied lines again. Otherwise they are finished.
  const stateOf = (draft: LineDraft): "applied" | "skipped" | "pending" => {
    const state = lineStates[draft.line.id];
    if (state?.status === "applied") return allowReapply ? "pending" : "applied";
    return state?.status === "skipped" ? "skipped" : "pending";
  };
  const pendingDrafts = drafts.filter((draft) => stateOf(draft) === "pending");
  const skippedDrafts = drafts.filter((draft) => stateOf(draft) === "skipped");
  const appliedCount = drafts.filter((draft) => stateOf(draft) === "applied").length;
  const selectedDrafts = pendingDrafts.filter((draft) => draft.selected);
  // Lines can follow each other in parts only within one extraction version.
  const continuable = data.applied.length > 0 && data.applied_version === activeVersion;
  const reapplyBlocked = data.applied.length > 0 && !continuable && !allowReapply;

  const amountError = (value: string) => value.trim() !== "" && parseMoney(value) == null;
  const purchaseErrors: string[] = [];
  if (purchaseAction !== "none" && amountError(total)) {
    purchaseErrors.push("Purchase amounts must be non-negative with at most two decimal places. Credit notes remain evidence; no refund is recorded by this form.");
  }
  if (purchaseAction === "existing" && !purchaseId) {
    purchaseErrors.push("Choose the existing purchase.");
  }
  // A line's messages are shown inside that line, beside what must be corrected.
  const lineErrors: Record<string, string[]> = Object.fromEntries(
    pendingDrafts.map((draft) => [draft.line.id, lineDraftErrors(draft)]),
  );
  const validationErrors = [
    ...purchaseErrors,
    ...new Set(selectedDrafts.flatMap((draft) => lineErrors[draft.line.id] ?? [])),
  ];
  const editedDocumentFields =
    merchant !== fieldValue(data.fields.merchant ?? document.merchant) ||
    documentDate !== fieldValue(data.fields.document_date ?? document.document_date);
  const selectedLineCount = selectedDrafts.length;
  const createCount = selectedDrafts.filter((draft) => draft.action === "create").length;
  const updateCount = selectedDrafts.filter((draft) => draft.action === "update").length;
  const linkCount = selectedDrafts.filter((draft) => draft.action === "link").length;
  const allSelected = pendingDrafts.length > 0 && pendingDrafts.every((draft) => draft.selected);
  const purchaseRecorded = continuable && data.applied.some((entry) => entry.purchase_id);
  const aiAvailable = Boolean(
    aiStatus?.configured &&
      (aiStatus.mode === "local" || aiStatus.cloud_consent),
  );

  const updateDraft = (lineId: string, update: (draft: LineDraft) => LineDraft) => {
    editedRef.current = true;
    setDrafts((current) =>
      current.map((draft) => (draft.line.id === lineId ? update(draft) : draft)),
    );
  };

  const matchFor = (lineId: string): ExtractionLineMatch | undefined =>
    matches.find((match) => match.line_id === lineId);

  const candidateFor = (draft: LineDraft): CandidateItem | undefined =>
    matchFor(draft.line.id)?.candidates.find((candidate) => candidate.id === draft.itemId);

  const selectCandidate = (draft: LineDraft, candidate: CandidateItem) => {
    updateDraft(draft.line.id, (current) => ({
      ...current,
      action: "link",
      itemId: candidate.id,
    }));
  };

  const addManualCandidate = (draft: LineDraft, item: ItemListEntry) => {
    const candidate = candidateFromItem(item);
    setMatches((current) => {
      const existing = current.find((match) => match.line_id === draft.line.id);
      if (!existing) {
        return [
          ...current,
          {
            line_id: draft.line.id,
            candidates: [candidate],
            quality: "possible",
            reasons: candidate.reasons,
          },
        ];
      }
      return current.map((match) =>
        match.line_id === draft.line.id
          ? {
              ...match,
              candidates: [
                candidate,
                ...match.candidates.filter((entry) => entry.id !== candidate.id),
              ],
            }
          : match,
      );
    });
    updateDraft(draft.line.id, (current) => ({
      ...current,
      action: "link",
      itemId: candidate.id,
    }));
    setManualLineId(null);
  };

  const warrantySupported = Boolean(
    data.fields.warranty_provider ||
      data.fields.warranty_start ||
      data.fields.warranty_end ||
      data.fields.warranty_months,
  );

  const acceptRefinement = () => {
    if (!refinement) return;
    loadProposal(
      refinement.fields,
      refinement.lines,
      refinement.matches,
      refinement.version,
      data.purchase_eligible,
    );
    setActiveRefinement(refinement);
    setRefinement(null);
    toast.success("AI refinement added to the review draft; apply is still separate");
  };

  const rejectRefinement = () => {
    retryEnhancement.mutate("cancel");
  };

  const revertRefinement = () => {
    if (!sourceData) return;
    loadProposal(
      sourceData.fields,
      sourceData.lines,
      sourceData.matches,
      sourceData.version,
      sourceData.purchase_eligible,
    );
    setRefinement(null);
    setActiveRefinement(null);
  };

  const refinementFieldRows = refinement
    ? [
        ["Merchant", refinement.fields.merchant],
        ["Purchase date", refinement.fields.purchase_date],
        ["Document date", refinement.fields.document_date],
        ["Currency", refinement.fields.currency],
        [
          "Total",
          refinement.fields.total_cents == null
            ? null
            : formatCurrency(refinement.fields.total_cents, refinement.fields.currency ?? currency),
        ],
        ["Order", refinement.fields.order_number],
        ["Brand", refinement.fields.brand],
        ["Model", refinement.fields.model],
        ["Serial", refinement.fields.serial_numbers.join(", ") || null],
        ["Warranty", refinement.fields.warranty_provider],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];

  // The button says exactly what one Apply will do. All of it is saved together.
  const detailsOnly = selectedLineCount === 0 && editedDocumentFields &&
    (data.applied.length === 0 || allowReapply);
  const applyParts = [
    createCount ? `add ${pluralize(createCount, "item")}` : null,
    updateCount ? `update ${pluralize(updateCount, "item")}` : null,
    linkCount ? `link ${pluralize(linkCount, "item")}` : null,
    selectedLineCount === 0 ? null
      : purchaseAction === "create" ? (purchaseRecorded ? "add to the recorded purchase" : "record the purchase")
      : purchaseAction === "existing" ? "use the existing purchase" : null,
    detailsOnly ? "save the document details" : null,
  ].filter(Boolean);
  const applyLabel = applyParts.length ? `Apply: ${applyParts.join(", ")}` : "Apply: nothing selected";

  const applyDisabled =
    applyMutation.isPending ||
    newVersionAvailable ||
    reapplyBlocked ||
    validationErrors.length > 0 ||
    (selectedLineCount === 0 && !detailsOnly);

  // Applies these lines now. A line that is not ready opens and says what is missing.
  const applyLines = (lineIds: string[]) => {
    if (applyMutation.isPending || newVersionAvailable || reapplyBlocked) return;
    setAttempted((current) => new Set([...current, ...lineIds]));
    const blocked = lineIds.filter((id) => (lineErrors[id]?.length ?? 0) > 0);
    if (blocked.length) {
      setOpenLines((current) => new Set([...current, ...blocked]));
      return;
    }
    if (lineIds.length && purchaseErrors.length) {
      toast.error(purchaseErrors[0]);
      return;
    }
    applyMutation.mutate(lineIds);
  };
  const setLineOpen = (lineId: string, next: boolean) =>
    setOpenLines((current) => {
      const copy = new Set(current);
      if (next) copy.add(lineId);
      else copy.delete(lineId);
      return copy;
    });
  const roomName = (roomId: string) => rooms.find((room) => room.id === roomId)?.name;
  const strongQuality = (quality: string | undefined) =>
    quality === "exact_identifier" || quality === "strong";

  return (
    <div className="mt-5 space-y-5" onChangeCapture={() => { editedRef.current = true; }}>
      {!open && ["queued", "running"].includes(data.enhancement?.status ?? "") && (
        <div className="rounded-xl border border-brass/25 bg-brass-soft/30 p-3.5 text-xs">
          <p role="status">Preparing one AI-assisted review. Local evidence is already available.</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => toggleReview(true)}>
            Use local/manual review now
          </Button>
        </div>
      )}
      {newVersionAvailable && (
        <div className="rounded-xl border border-brass/25 p-3 text-xs">
          <p role="alert">New document extraction is available. Your edited draft is unchanged. Loading refreshed extraction replaces your edits.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => {
            if (!sourceData) return;
            loadProposal(sourceData.fields, sourceData.lines, sourceData.matches,
              sourceData.version, sourceData.purchase_eligible);
            versionRef.current = sourceData.version;
            manualChosenRef.current = true;
            editedRef.current = false;
            setAiStatus(sourceData.ai_status);
            setAiWarnings([]);
            setRefinement(null);
            setActiveRefinement(null);
            setNewVersionAvailable(false);
          }}>Replace draft with refreshed extraction</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {pluralize(data.lines.filter((line) => line.kind === "product").length, "product line")}
            {" · "}Nothing changes until Apply
          </p>
          <div className="flex flex-wrap gap-1.5">
            {data.applied.length > 0 && <Badge variant="brass">Already applied</Badge>}
            {data.duplicate_documents.length > 0 && <Badge variant="brass">Possible duplicate</Badge>}
            {(data.warnings.length > 0 || data.fields.uncertain_fields.length > 0 ||
              data.lines.some((line) => line.warnings.length > 0) || aiWarnings.length > 0 ||
              validationErrors.length > 0 || (applyResult?.warnings.length ?? 0) > 0 ||
              drafts.some((draft) => draft.line.warnings.length > 0) ||
              (data.suggested_refinement?.warnings.length ?? 0) > 0 ||
              (data.financial_validation != null && data.financial_validation.status !== "consistent")) && (
              <Badge variant="brass"><AlertTriangle className="mr-1 size-3" />Review warnings</Badge>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" aria-expanded={open} aria-controls={reviewId}
          onClick={() => toggleReview(!open)}>
          {open ? "Hide extraction" : "Review extraction"}
        </Button>
      </div>
      {data.enhancement && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
          <Badge variant="outline">{refinementActive ? "AI-assisted review" : "Local results"}</Badge>
          <Badge variant={data.enhancement.status === "ready" ? "brass" : "outline"}>
            {refinementActive ? "Check and Apply when ready" : data.enhancement.reason === "no_changes"
              ? "AI review complete · no changes" : enhancementLabel(data.enhancement)}
          </Badge>
          {data.suggested_refinement && !refinement &&
            data.suggested_refinement.version !== activeRefinement?.version && (
            <Button size="sm" variant="outline"
              onClick={() => {
                setRefinement(data.suggested_refinement ?? null);
                toggleReview(true);
              }}>
              <Sparkles /> Review AI suggestions
            </Button>
          )}
          {data.enhancement.error && <span>{data.enhancement.error}</span>}
          {["off", "failed", "skipped"].includes(data.enhancement.status) && aiAvailable && (
            <Button size="sm" variant="outline" onClick={() => queueOperation("interpret")}
              disabled={aiProcessing || matchMutation.isPending || retryEnhancement.isPending}>
              {queueAi.isPending ? <Spinner /> : <Sparkles />} Retry AI only
            </Button>
          )}
          {["queued", "running"].includes(data.enhancement.status) && (
            <Button size="sm" variant="ghost" onClick={() => retryEnhancement.mutate("cancel")}
              disabled={retryEnhancement.isPending}>
              Skip AI suggestions
            </Button>
          )}
          {data.enhancement.status === "ready" && data.suggested_refinement && !refinementActive && (
            <Button size="sm" variant="ghost" onClick={() => retryEnhancement.mutate("cancel")}
              disabled={retryEnhancement.isPending}>
              Dismiss AI suggestions
            </Button>
          )}
        </div>
      )}
      {retryEnhancement.error && <FormError message={getApiErrorMessage(retryEnhancement.error)} />}
      {queueAi.error && <FormError message={getApiErrorMessage(queueAi.error)} />}
      {opened && <div id={reviewId} hidden={!open} className="space-y-5">
      {refinementActive && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brass/25 bg-brass-soft/30 p-3 text-xs">
          <p><Sparkles className="mr-1 inline size-3.5" />AI-assisted draft. Check every value before Apply.</p>
          <Button type="button" size="sm" variant="outline" onClick={revertRefinement}>
            Use deterministic proposal
          </Button>
        </div>
      )}
      {data.financial_validation && data.financial_validation.status !== "consistent" && (
        <section className="rounded-xl border border-brass/30 bg-brass-soft/35 p-3.5 text-xs" aria-label="Financial checks">
          <h3 className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-3.5" />Check invoice amounts and evidence</h3>
          <p className="mt-1 text-muted-foreground">
            {data.financial_validation.status === "insufficient_evidence"
              ? "There is not enough evidence to reconcile this invoice. Confirm unknown amounts from the original."
              : "Some invoice amounts or source details need your attention. Nothing is corrected automatically."}
            {" "}These checks describe the source extraction, before your corrections.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {data.financial_validation.checks.map((check) => (
              <li key={`${check.code}:${check.line_ids.join(",")}`}>
                {check.message}
                {check.line_ids.map((lineId) => {
                  const line = data.lines.find((entry) => entry.id === lineId);
                  return line && <a key={lineId} href={`#extraction-source-${lineId}`}
                    className="ml-2 underline underline-offset-2">Review line {line.line_number}</a>;
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {applyResult && (
        <div className="rounded-xl border border-sage/25 bg-sage-soft/60 p-3.5 text-2xs leading-relaxed">
          <p className="flex items-center gap-1.5 font-medium text-accent-foreground">
            <Check className="size-3.5" /> Applied
          </p>
          <p className="mt-1 text-muted-foreground">
            {pluralize(applyResult.created_item_ids.length, "new item")} created,{" "}
            {pluralize(applyResult.updated_item_ids.length, "item")} updated,{" "}
            {pluralize(applyResult.linked_item_ids.length, "item")} reviewed for purchase
            evidence. {applyResult.purchase_id ? "A shared purchase was recorded." : ""}
          </p>
          {applyResult.items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {applyResult.items.map((item) => (
                <Link key={item.id} to={`/items/${item.id}`}>
                  <Badge variant="secondary">{item.name}</Badge>
                </Link>
              ))}
            </div>
          )}
          {applyResult.warnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-2xs text-brass">
              {applyResult.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {data.applied.length > 0 && (
        <div className="rounded-xl border border-brass/25 bg-brass-soft/50 p-3.5 text-2xs leading-relaxed">
          <p className="flex items-center gap-1.5 font-medium text-brass">
            <AlertTriangle className="size-3.5" />{" "}
            {continuable && pendingDrafts.length + skippedDrafts.length > 0
              ? "Part of this document is applied"
              : "This extraction was already applied"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {continuable
              ? `${appliedCount} of ${drafts.length} lines are applied. The other lines can still be applied; an applied line is never applied twice. `
              : `Last applied ${formatDate(data.applied[0]?.applied_at ?? "")}. Retries with the same request id return the previous result. `}
            To intentionally create another purchase or stock increase, explicitly allow a
            re-apply.
          </p>
          <label className="mt-2 flex items-center gap-2 text-2xs">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={allowReapply}
              onChange={(event) => setAllowReapply(event.target.checked)}
            />
            Allow a new reviewed apply with a new request id
          </label>
        </div>
      )}

      {data.duplicate_documents.length > 0 && (
        <div className="rounded-xl border border-brass/25 bg-brass-soft/40 p-3.5 text-2xs leading-relaxed text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-brass">
            <AlertTriangle className="size-3.5" /> Identical file content is already in the
            library
          </p>
          <p className="mt-1">
            Housetory does not merge or delete either document automatically. Review the
            existing record before applying another purchase.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {data.duplicate_documents.map((entry) => (
              <Link key={entry.id} to={`/documents/${entry.id}`}>
                <Badge variant="outline">{entry.title}</Badge>
              </Link>
            ))}
          </div>
        </div>
      )}

      {refinement && (
        <div className="rounded-xl border border-brass/30 bg-brass-soft/35 p-3.5 text-2xs leading-relaxed">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-medium text-brass">
              <Sparkles className="size-3.5" />
              AI refinement proposal
            </p>
            {refinement && (
              <span className="text-2xs text-muted-foreground">
                {refinement.ai_status.provider_label ?? refinement.ai_status.provider} ·{" "}
                {refinement.version.slice(0, 8)}
              </span>
            )}
          </div>
          <p className="mt-1 text-muted-foreground">
            AI suggestions are separate from the deterministic proposal and your edits.
            Nothing is saved until you accept the refinement and then apply the reviewed
            changes. Accepting replaces the current draft fields, lines and matches.
          </p>
          {refinement && refinementFieldRows.length > 0 && (
            <div className="mt-2 grid gap-1 rounded-lg border border-border/50 bg-background/40 p-2.5 sm:grid-cols-2">
              {refinementFieldRows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="max-w-[65%] truncate text-right font-medium">{value}</span>
                </div>
              ))}
            </div>
          )}
          {refinement && (
            <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border/50 bg-background/40 p-2.5">
              {refinement.lines.map((line) => (
                <div key={line.id} className="border-b border-border/40 pb-1.5 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {line.description}{" "}
                      <span className="font-normal text-muted-foreground">({line.kind})</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {line.quantity ? `×${line.quantity} · ` : ""}
                      {line.line_total_cents == null
                        ? "amount unknown"
                        : formatCurrency(line.line_total_cents, refinement.fields.currency ?? currency)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground">
                    {line.evidence.text}
                  </p>
                  {refinement.matches.find((match) => match.line_id === line.id)?.candidates.length ? (
                    <p className="mt-1 text-2xs text-muted-foreground">
                      Suggested inventory matches:{" "}
                      {refinement.matches.find((match) => match.line_id === line.id)
                        ?.candidates.map((candidate) => candidate.name).join(", ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {refinement?.warnings && refinement.warnings.length > 0 && (
            <p className="mt-2 text-2xs text-brass">{refinement.warnings.join(" ")}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button type="button" size="sm" onClick={acceptRefinement}>
              <Check /> Accept AI refinement
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={rejectRefinement}
              disabled={retryEnhancement.isPending}>
              Reject AI suggestion
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-secondary/20 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">Extracted proposal</p>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {data.source_artifact === "cleaned_pdf"
                ? "Read from the cleaned scan PDF"
                : "Read from the original document"}{" "}
              · {pluralize(data.lines.length, "source line")} · version {data.version.slice(0, 8)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={data.purchase_eligible ? "sage" : "outline"}>
              {data.purchase_eligible ? "Purchase evidence" : "Not proof of purchase"}
            </Badge>
            <Badge variant={data.ai_status.configured ? "brass" : "outline"}>
              {data.ai_status.configured ? "AI available" : "Deterministic only"}
            </Badge>
          </div>
        </div>
        {data.warnings.length > 0 && (
          <ul className="mt-3 space-y-1.5 rounded-lg border border-brass/20 bg-brass-soft/40 p-3 text-2xs leading-relaxed text-muted-foreground">
            {data.warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-brass" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
        {data.fields.uncertain_fields.length > 0 && (
          <p className="mt-2 text-2xs text-brass">
            Verify uncertain fields: {data.fields.uncertain_fields.join(", ")}.
          </p>
        )}
      </div>

      <section className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-[1.25rem] tracking-[-0.02em]">Document fields</h3>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Empty fields stay empty. Values are not invented from a document type that does
              not support them.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {refinementActive && <Badge variant="brass">AI-refined proposal</Badge>}
            {editedDocumentFields && <Badge variant="brass">Edited</Badge>}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Merchant" htmlFor="extraction-merchant" optional>
            <Input
              id="extraction-merchant"
              value={merchant}
              maxLength={160}
              onChange={(event) => setMerchant(event.target.value)}
            />
            {document.merchant && document.merchant !== merchant && (
              <p className="mt-1 text-2xs text-muted-foreground">
                Current document value: {document.merchant}
              </p>
            )}
          </Field>
          <Field label="Order or invoice number" htmlFor="extraction-order" optional>
            <Input
              id="extraction-order"
              value={orderNumber}
              maxLength={120}
              onChange={(event) => setOrderNumber(event.target.value)}
            />
          </Field>
          <Field label="Purchase date" htmlFor="extraction-purchase-date" optional>
            <Input
              id="extraction-purchase-date"
              type="date"
              value={purchaseDate}
              onChange={(event) => setPurchaseDate(event.target.value)}
            />
          </Field>
          <Field label="Document date" htmlFor="extraction-document-date" optional>
            <Input
              id="extraction-document-date"
              type="date"
              value={documentDate}
              onChange={(event) => setDocumentDate(event.target.value)}
            />
          </Field>
          <Field label="Currency" htmlFor="extraction-currency">
            <Select
              id="extraction-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
            {!data.fields.currency && <p className="mt-1 text-2xs text-brass">
              Currency is unknown in the source. Confirm the selected household default before applying.
            </p>}
          </Field>
          <Field label="Total" htmlFor="extraction-total" optional>
            <Input
              id="extraction-total"
              type="number"
              step="0.01"
              inputMode="decimal"
              value={total}
              onChange={(event) => setTotal(event.target.value)}
            />
          </Field>
        </div>
        {(data.fields.subtotal_cents != null ||
          data.fields.tax_cents != null ||
          data.fields.discount_cents != null ||
          data.fields.shipping_cents != null) && (
          <p className="mt-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
            Recorded subtotal{" "}
            {data.fields.subtotal_cents == null ? "unknown" : formatCurrency(data.fields.subtotal_cents, currency)} · tax{" "}
            {data.fields.tax_cents == null ? "unknown" : formatCurrency(data.fields.tax_cents, currency)} · discount{" "}
            {data.fields.discount_cents == null ? "unknown" : formatCurrency(data.fields.discount_cents, currency)} · shipping{" "}
            {data.fields.shipping_cents == null ? "unknown" : formatCurrency(data.fields.shipping_cents, currency)}. These charge lines
            are kept separate and are not allocated to products.
            {data.financial_validation && ` Tax treatment: ${data.financial_validation.tax_treatment}.`}
          </p>
        )}
        {Object.keys(data.fields.field_sources).length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-2xs text-muted-foreground">
              Field source evidence
            </summary>
            <dl className="mt-2 space-y-1.5 text-2xs text-muted-foreground">
              {Object.entries(data.fields.field_sources).map(([key, source]) => (
                <div key={key} className="grid gap-1 sm:grid-cols-[140px_1fr]">
                  <dt className="font-medium text-foreground/70">{key.replaceAll("_", " ")}</dt>
                  <dd>{source}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-[1.35rem] tracking-[-0.025em]">
              Product lines
            </h3>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              Choose likely matches first, create only the items you want, or skip lines that
              are not inventory.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => queueOperation("interpret")}
              disabled={!aiAvailable || aiProcessing || matchMutation.isPending || drafts.length === 0}
              title={
                aiAvailable
                  ? "Ask the configured document AI to refine fields and product lines"
                  : "Configure and consent to the documents AI task first"
              }
            >
              {queueAi.isPending && queueAi.variables === "interpret" ? <Spinner /> : <Sparkles />}
              Refine fields &amp; lines
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => matchMutation.mutate()}
              disabled={matchMutation.isPending || drafts.length === 0}
            >
              {matchMutation.isPending ? <Spinner /> : <Search />}
              Refresh matches
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => queueOperation("matches")}
              disabled={!aiAvailable || aiProcessing || matchMutation.isPending || drafts.length === 0}
              title={
                aiAvailable
                  ? "Queue a reviewed candidate-ranking proposal with the configured document AI"
                  : "Configure and consent to the documents AI task first"
              }
            >
              <Wand2 />
              Re-rank matches
            </Button>
          </div>
        </div>

        {aiProcessing && <p role="status" className="text-2xs text-muted-foreground">
          {queueAi.isPending ? "Requesting bounded AI review…" : "Document processing is active; use the processing controls above to cancel."}
          {" "}Suggestions use stored document evidence. Your current draft stays editable.
        </p>}
        {aiWarnings.length > 0 && (
          <div className="rounded-lg border border-brass/20 bg-brass-soft/40 px-3 py-2 text-2xs text-muted-foreground">
            {aiWarnings.join(" ")}
          </div>
        )}

        {pendingDrafts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/70 p-2.5">
            <Button type="button" size="sm" variant="outline" className="min-h-11 lg:min-h-9"
              disabled={applyMutation.isPending}
              onClick={() => setDrafts((current) => current.map((draft) =>
                stateOf(draft) === "pending" ? { ...draft, selected: !allSelected } : draft))}>
              {allSelected ? "Clear selection" : "Select all"}
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {selectedLineCount} selected · lines that are not selected stay pending
            </span>
          </div>
        )}
        <DraftSaveNotice show={autosave.unsaved} className="px-1 text-xs text-muted-foreground" />
        {drafts.length === 0 ? (
          <div className="surface px-4 py-6 text-xs text-muted-foreground">
            No product lines were recognised. Review the source text and use manual search or
            create an item from the document fields if appropriate.
          </div>
        ) : (
          drafts.filter((draft) => stateOf(draft) !== "skipped").map((draft) => {
            const lineMatch = matchFor(draft.line.id);
            const selected = candidateFor(draft);
            const edited =
              draft.description !== draft.line.description ||
              draft.quantity !== (draft.line.quantity == null ? "" : String(draft.line.quantity)) ||
              draft.unitPrice !== centsInput(draft.line.unit_price_cents) ||
              draft.lineTotal !== centsInput(draft.line.line_total_cents);
            const state = lineStates[draft.line.id];
            if (stateOf(draft) === "applied") {
              return (
                <div key={draft.line.id} id={`extraction-source-${draft.line.id}`}>
                  <ReviewRow
                    title={draft.description}
                    quantity={draft.quantity}
                    className="opacity-80"
                    values={state?.item ? [{
                      label: state.action === "create" ? "Added as" : state.action === "update" ? "Updated" : "Linked to",
                      value: state.item.name,
                    }] : []}
                    status={
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {state?.action === "create" ? "Added" : state?.action === "update" ? "Updated" : "Linked"}
                        </span>
                        {state?.item && (
                          <Link to={`/items/${state.item.id}`}
                            className="inline-flex min-h-11 items-center font-medium text-foreground underline-offset-4 hover:underline lg:min-h-0">
                            Open item
                          </Link>
                        )}
                      </p>
                    }
                  />
                </div>
              );
            }
            const unsure = !strongQuality(lineMatch?.quality);
            const updateValues: ReviewValue[] = selected ? ([
              ["Name", selected.name, draft.updates.name],
              ["Brand", selected.brand, draft.updates.brand],
              ["Model", selected.model, draft.updates.model],
              ["Serial", selected.serial_number, draft.updates.serialNumber],
              ["Room", selected.room_name, draft.updates.roomId ? roomName(draft.updates.roomId) ?? "" : ""],
            ] as Array<[string, string | null, string]>)
              .filter(([, , next]) => next.trim())
              .map(([label, before, next]) => ({ label, before: before || "empty", value: next.trim() })) : [];
            // The row says what the line would do. For an existing item it shows old → new.
            const values: ReviewValue[] = [
              ...(draft.lineTotal.trim()
                ? [{
                    label: "Line total",
                    value: draft.lineTotal,
                    uncertain: amountError(draft.lineTotal),
                    // The same update as the Line total field of the editor.
                    edit: {
                      description: `Line total of line ${draft.line.line_number}`,
                      value: draft.lineTotal,
                      inputMode: "decimal" as const,
                      validate: (value: string) =>
                        value === "" || parseMoney(value) != null
                          ? null : "Enter an amount such as 24.50, or leave it empty.",
                      onCommit: (value: string) =>
                        updateDraft(draft.line.id, (current) => ({ ...current, lineTotal: value })),
                    },
                  }]
                : []),
              ...(draft.action === "create"
                ? [
                    {
                      label: "Add as",
                      value: draft.newItem.name.trim() || "no name",
                      uncertain: !draft.newItem.name.trim(),
                      // The same update as the New item name field of the editor.
                      edit: {
                        label: "Item name",
                        description: `Name of the new item of line ${draft.line.line_number}`,
                        value: draft.newItem.name,
                        validate: (value: string) => (value ? null : "A new item needs a name."),
                        onCommit: (value: string) => updateDraft(draft.line.id, (current) => ({
                          ...current, newItem: { ...current.newItem, name: value },
                        })),
                      },
                    },
                    {
                      label: "Room",
                      value: roomName(draft.newItem.roomId) ?? "not chosen",
                      uncertain: !draft.newItem.roomId,
                    },
                  ]
                : [{
                    label: draft.action === "update" ? "Update" : "Link to",
                    value: selected?.name ?? "no item chosen",
                    uncertain: !selected || unsure,
                  }]),
              ...(draft.action === "update" ? updateValues : []),
              ...(draft.addQuantity && draft.action !== "create"
                ? [{ label: "Stock", value: `+${draft.quantity || "?"}` }]
                : []),
            ];
            const shownErrors = draft.selected || attempted.has(draft.line.id)
              ? lineErrors[draft.line.id] ?? [] : [];
            const lineOpen = openLines.has(draft.line.id);
            return (
              <div key={draft.line.id} id={`extraction-source-${draft.line.id}`}>
              <ReviewRow
                title={draft.description}
                titleLabel={`Name of line ${draft.line.line_number}`}
                onTitleChange={(description) =>
                  updateDraft(draft.line.id, (current) => ({
                    ...current,
                    description,
                    // The new item keeps following the line name until it gets its own.
                    newItem: current.newItem.name === current.description
                      ? { ...current.newItem, name: description } : current.newItem,
                  }))}
                quantity={draft.quantity}
                onQuantityChange={(quantity) =>
                  updateDraft(draft.line.id, (current) => ({ ...current, quantity }))}
                titleValidate={(value) => (value ? null : "Give this line a name.")}
                quantityValidate={(value) =>
                  value === "" || parseQuantity(value)
                    ? null : "Enter a whole number of at least 1, or leave it empty."}
                values={values}
                disabled={applyMutation.isPending || skipMutation.isPending}
                selection={{
                  checked: draft.selected,
                  onChange: (next) => setDrafts((current) => current.map((entry) =>
                    entry.line.id === draft.line.id ? { ...entry, selected: next } : entry)),
                  label: `Select line ${draft.line.line_number}: ${draft.description}`,
                }}
                badges={
                  <>
                    <Badge variant="outline">Line {draft.line.line_number}</Badge>
                    <Badge
                      variant={
                        lineMatch?.quality === "exact_identifier"
                          ? "sage"
                          : lineMatch?.quality === "strong"
                            ? "brass"
                            : "outline"
                      }
                    >
                      {qualityLabel(lineMatch?.quality ?? "none")}
                    </Badge>
                    {refinementActive && <Badge variant="brass">AI-refined line</Badge>}
                    {edited && <Badge variant="brass">Edited</Badge>}
                    {draft.line.warnings.length > 0 && (
                      <Badge variant="brass"><AlertTriangle className="mr-1 size-3" />Check</Badge>
                    )}
                  </>
                }
                error={shownErrors.length ? [...new Set(shownErrors)].join(" ") : null}
                primary={{
                  label: draft.action === "create" ? "Add item"
                    : draft.action === "update" ? "Apply changes" : "Link to item",
                  onClick: () => applyLines([draft.line.id]),
                  disabled: newVersionAvailable || reapplyBlocked,
                  pending: applyMutation.isPending && Boolean(applyMutation.variables?.includes(draft.line.id)),
                }}
                onSkip={() => skipMutation.mutate({ draft, restore: false })}
                expand={{ open: lineOpen, onOpenChange: (next) => setLineOpen(draft.line.id, next), label: "Edit" }}
              >
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_82px_112px_112px]">
                  <Field label="Description" htmlFor={`line-description-${draft.line.id}`}>
                    <Input
                      id={`line-description-${draft.line.id}`}
                      value={draft.description}
                      onChange={(event) =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      maxLength={300}
                    />
                  </Field>
                  <Field label="Qty" htmlFor={`line-qty-${draft.line.id}`}>
                    <Input
                      id={`line-qty-${draft.line.id}`}
                      type="number"
                      min={1}
                      step={1}
                      value={draft.quantity}
                      onChange={(event) =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          quantity: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Unit price" htmlFor={`line-unit-${draft.line.id}`} optional>
                    <Input
                      id={`line-unit-${draft.line.id}`}
                      type="number"
                      step="0.01"
                      value={draft.unitPrice}
                      readOnly
                      aria-describedby={`line-unit-note-${draft.line.id}`}
                      className="bg-secondary/30"
                    />
                  </Field>
                  <Field label="Line total" htmlFor={`line-total-${draft.line.id}`} optional>
                    <Input
                      id={`line-total-${draft.line.id}`}
                      type="number"
                      step="0.01"
                      value={draft.lineTotal}
                      onChange={(event) =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          lineTotal: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
                <p id={`line-unit-note-${draft.line.id}`} className="text-2xs text-muted-foreground">
                  Unit price is source evidence. Reviewed quantity and line total determine purchase allocation.
                </p>

                {draft.line.warnings.length > 0 && (
                  <ul className="space-y-1 text-2xs text-brass">
                    {draft.line.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}

                <details className="text-2xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Source line evidence
                    {draft.line.evidence.page ? ` · page ${draft.line.evidence.page}` : ""}
                  </summary>
                  <p className="mt-1 rounded-lg bg-secondary/35 px-2.5 py-2 font-mono text-2xs leading-relaxed text-foreground/70">
                    {draft.line.evidence.text}
                  </p>
                </details>

                <div className="rounded-xl border border-border/70 bg-background/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-2xs font-medium">Suggested existing items</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setManualLineId((current) =>
                          current === draft.line.id ? null : draft.line.id,
                        )
                      }
                    >
                      <Search />
                      Search all items
                    </Button>
                  </div>
                  {lineMatch?.candidates.length ? (
                    <div className="mt-2 grid gap-2">
                      {lineMatch.candidates.map((candidate) => {
                        const active = draft.itemId === candidate.id && draft.action !== "create";
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => selectCandidate(draft, candidate)}
                            className={cn(
                              "rounded-lg border px-3 py-2 text-left transition-colors",
                              active
                                ? "border-sage/45 bg-sage-soft/45"
                                : "border-border/60 bg-card/40 hover:bg-secondary/40",
                            )}
                          >
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-medium">{candidate.name}</span>
                              {candidate.exact_identifier && (
                                <Badge variant="sage">Identifier verified</Badge>
                              )}
                              <span className="text-2xs text-muted-foreground">
                                ×{candidate.quantity}
                                {candidate.on_loan_quantity
                                  ? ` · ${candidate.on_loan_quantity} on loan`
                                  : ""}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-2xs text-muted-foreground">
                              {[candidate.room_name, candidate.location_name]
                                .filter(Boolean)
                                .join(" / ") || "No place assigned"}
                              {candidate.purchase
                                ? ` · purchase ${[
                                    candidate.purchase.merchant,
                                    candidate.purchase.purchase_date,
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}`
                                : " · no purchase recorded"}
                            </span>
                            {candidate.reasons.length > 0 && (
                              <span className="mt-1 block text-2xs text-brass">
                                {candidate.reasons.join(" · ")}
                              </span>
                            )}
                            {candidate.warranty && (
                              <span className="mt-0.5 block text-2xs text-muted-foreground">
                                Existing warranty:{" "}
                                {[candidate.warranty.provider, candidate.warranty.end_date]
                                  .filter(Boolean)
                                  .join(" until ") || "recorded"}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-2 text-2xs text-muted-foreground">
                      No likely household match. Search all items or create a new one.
                    </p>
                  )}

                  {manualLineId === draft.line.id && (
                    <ItemSearchPicker
                      disabled={applyMutation.isPending}
                      onSelect={(item) => addManualCandidate(draft, item)}
                    />
                  )}

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selected && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant={draft.action === "link" ? "default" : "outline"}
                          onClick={() =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              action: "link",
                              itemId: selected.id,
                            }))
                          }
                        >
                          <Link2 /> Link only
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={draft.action === "update" ? "default" : "outline"}
                          onClick={() =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              action: "update",
                              itemId: selected.id,
                            }))
                          }
                        >
                          Update details
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant={draft.action === "create" ? "default" : "outline"}
                      onClick={() =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          action: "create",
                          itemId: "",
                        }))
                      }
                    >
                      <PackagePlus /> Create new item
                    </Button>
                  </div>

                  {draft.action === "create" && (
                    <div className="mt-3 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
                      <Field label="New item name" htmlFor={`new-name-${draft.line.id}`}>
                        <Input
                          id={`new-name-${draft.line.id}`}
                          value={draft.newItem.name}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: { ...current.newItem, name: event.target.value },
                            }))
                          }
                          maxLength={200}
                        />
                      </Field>
                      <Field label="Destination room" htmlFor={`new-room-${draft.line.id}`}>
                        <Select
                          id={`new-room-${draft.line.id}`}
                          value={draft.newItem.roomId}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: {
                                ...current.newItem,
                                roomId: event.target.value,
                                locationId: "",
                              },
                            }))
                          }
                        >
                          <option value="">Choose a room</option>
                          {rooms.map((room) => (
                            <option key={room.id} value={room.id}>
                              {room.property?.name
                                ? `${room.property.name} / ${room.name}`
                                : room.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Optional container" htmlFor={`new-location-${draft.line.id}`}>
                        <Select
                          id={`new-location-${draft.line.id}`}
                          value={draft.newItem.locationId}
                          disabled={!draft.newItem.roomId}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: { ...current.newItem, locationId: event.target.value },
                            }))
                          }
                        >
                          <option value="">Room only</option>
                          {locations
                            .filter((location) => location.room_id === draft.newItem.roomId)
                            .map((location) => (
                              <option key={location.id} value={location.id}>
                                {location.identifier ?? location.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <div className="sm:col-span-2">
                        <MoreDetails defaultOpen={Boolean(
                          draft.newItem.brand || draft.newItem.model || draft.newItem.serialNumber,
                        )}>
                          <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Brand" htmlFor={`new-brand-${draft.line.id}`} optional>
                        <Input
                          id={`new-brand-${draft.line.id}`}
                          value={draft.newItem.brand}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: { ...current.newItem, brand: event.target.value },
                            }))
                          }
                          maxLength={120}
                        />
                      </Field>
                      <Field label="Model" htmlFor={`new-model-${draft.line.id}`} optional>
                        <Input
                          id={`new-model-${draft.line.id}`}
                          value={draft.newItem.model}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: { ...current.newItem, model: event.target.value },
                            }))
                          }
                          maxLength={120}
                        />
                      </Field>
                      <Field label="Serial number" htmlFor={`new-serial-${draft.line.id}`} optional>
                        <Input
                          id={`new-serial-${draft.line.id}`}
                          value={draft.newItem.serialNumber}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              newItem: { ...current.newItem, serialNumber: event.target.value },
                            }))
                          }
                          maxLength={200}
                        />
                      </Field>
                          </div>
                        </MoreDetails>
                      </div>
                    </div>
                  )}

                  {draft.action === "update" && selected && (
                    <div className="mt-3 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
                      <p className="text-2xs text-muted-foreground sm:col-span-2">
                        Current values: {selected.name}
                        {selected.brand ? ` · ${selected.brand}` : ""}
                        {selected.model ? ` · ${selected.model}` : ""}
                        {selected.serial_number ? ` · serial ${selected.serial_number}` : ""}
                        {selected.room_name ? ` · ${selected.room_name}` : ""}
                        {selected.location_name ? ` / ${selected.location_name}` : ""}.
                        Leave a field blank to keep it unchanged.
                      </p>
                      <Field label="Name" htmlFor={`update-name-${draft.line.id}`} optional>
                        <Input
                          id={`update-name-${draft.line.id}`}
                          value={draft.updates.name}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: { ...current.updates, name: event.target.value },
                            }))
                          }
                          maxLength={200}
                        />
                      </Field>
                      <Field label="Brand" htmlFor={`update-brand-${draft.line.id}`} optional>
                        <Input
                          id={`update-brand-${draft.line.id}`}
                          value={draft.updates.brand}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: { ...current.updates, brand: event.target.value },
                            }))
                          }
                          maxLength={120}
                        />
                      </Field>
                      <Field label="Model" htmlFor={`update-model-${draft.line.id}`} optional>
                        <Input
                          id={`update-model-${draft.line.id}`}
                          value={draft.updates.model}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: { ...current.updates, model: event.target.value },
                            }))
                          }
                          maxLength={120}
                        />
                      </Field>
                      <Field label="Serial number" htmlFor={`update-serial-${draft.line.id}`} optional>
                        <Input
                          id={`update-serial-${draft.line.id}`}
                          value={draft.updates.serialNumber}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: { ...current.updates, serialNumber: event.target.value },
                            }))
                          }
                          maxLength={200}
                        />
                      </Field>
                      <Field label="Move to room" htmlFor={`update-room-${draft.line.id}`} optional>
                        <Select
                          id={`update-room-${draft.line.id}`}
                          value={draft.updates.roomId}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: {
                                ...current.updates,
                                roomId: event.target.value,
                                locationId: "",
                              },
                            }))
                          }
                        >
                          <option value="">Keep current room</option>
                          {rooms.map((room) => (
                            <option key={room.id} value={room.id}>
                              {room.property?.name
                                ? `${room.property.name} / ${room.name}`
                                : room.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Move to container" htmlFor={`update-location-${draft.line.id}`} optional>
                        <Select
                          id={`update-location-${draft.line.id}`}
                          value={draft.updates.locationId}
                          disabled={!draft.updates.roomId}
                          onChange={(event) =>
                            updateDraft(draft.line.id, (current) => ({
                              ...current,
                              updates: {
                                ...current.updates,
                                locationId: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">Keep current place</option>
                          {locations
                            .filter((location) => location.room_id === draft.updates.roomId)
                            .map((location) => (
                              <option key={location.id} value={location.id}>
                                {location.identifier ?? location.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    </div>
                  )}

                  <label className="mt-3 flex items-start gap-2 border-t border-border/60 pt-3 text-2xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 accent-primary"
                      checked={draft.addQuantity}
                      onChange={(event) =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          addQuantity: event.target.checked,
                        }))
                      }
                      disabled={draft.action !== "link" && draft.action !== "update"}
                    />
                    <span>
                      <span className="block font-medium">Add this quantity as new stock</span>
                      <span className="block text-2xs text-muted-foreground">
                        Linking a receipt does not increase an existing item&apos;s quantity
                        unless this is explicitly selected. Open loans are not changed.
                      </span>
                    </span>
                  </label>

                  {warrantySupported &&
                    ["create", "link", "update"].includes(draft.action) && (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <label className="flex items-start gap-2 text-2xs">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-3.5 accent-primary"
                            checked={draft.warranty.enabled}
                            onChange={(event) =>
                              updateDraft(draft.line.id, (current) => ({
                                ...current,
                                warranty: {
                                  ...current.warranty,
                                  enabled: event.target.checked,
                                },
                              }))
                            }
                          />
                          <span>
                            <span className="block font-medium">Apply extracted warranty evidence</span>
                            <span className="block text-2xs text-muted-foreground">
                              Only the fields present in the source are proposed. Review the
                              existing warranty above before replacing it.
                            </span>
                          </span>
                        </label>
                        {draft.warranty.enabled && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <Field label="Provider" htmlFor={`warranty-provider-${draft.line.id}`} optional>
                              <Input
                                id={`warranty-provider-${draft.line.id}`}
                                value={draft.warranty.provider}
                                onChange={(event) =>
                                  updateDraft(draft.line.id, (current) => ({
                                    ...current,
                                    warranty: { ...current.warranty, provider: event.target.value },
                                  }))
                                }
                                maxLength={160}
                              />
                            </Field>
                            <Field label="Start date" htmlFor={`warranty-start-${draft.line.id}`} optional>
                              <Input
                                id={`warranty-start-${draft.line.id}`}
                                type="date"
                                value={draft.warranty.startDate}
                                onChange={(event) =>
                                  updateDraft(draft.line.id, (current) => ({
                                    ...current,
                                    warranty: { ...current.warranty, startDate: event.target.value },
                                  }))
                                }
                              />
                            </Field>
                            <Field label="Duration (months)" htmlFor={`warranty-months-${draft.line.id}`} optional>
                              <Input
                                id={`warranty-months-${draft.line.id}`}
                                type="number"
                                min={1}
                                max={1200}
                                value={draft.warranty.months}
                                onChange={(event) =>
                                  updateDraft(draft.line.id, (current) => ({
                                    ...current,
                                    warranty: { ...current.warranty, months: event.target.value },
                                  }))
                                }
                              />
                            </Field>
                            <Field label="End date" htmlFor={`warranty-end-${draft.line.id}`} optional>
                              <Input
                                id={`warranty-end-${draft.line.id}`}
                                type="date"
                                value={draft.warranty.endDate}
                                onChange={(event) =>
                                  updateDraft(draft.line.id, (current) => ({
                                    ...current,
                                    warranty: { ...current.warranty, endDate: event.target.value },
                                  }))
                                }
                              />
                            </Field>
                          </div>
                        )}
                      </div>
                    )}
                </div>
              </ReviewRow>
              </div>
            );
          })
        )}
        {skippedDrafts.length > 0 && (
          <SkippedSection count={skippedDrafts.length}
            hint="Nothing was added for these lines. Restore puts a line back in the list with its edits.">
            {skippedDrafts.map((draft) => (
              <SkippedRow
                key={draft.line.id}
                title={draft.description || `Line ${draft.line.line_number}`}
                detail={`Line ${draft.line.line_number}`}
                disabled={skipMutation.isPending}
                onRestore={() => skipMutation.mutate({ draft, restore: true })}
              />
            ))}
          </SkippedSection>
        )}
      </section>

      {charges.length > 0 && (
        <details className="surface p-4 sm:p-5">
          <summary className="cursor-pointer text-xs font-medium">
            Charges, discounts and payment lines
            <span className="ml-2 text-2xs font-normal text-muted-foreground">
              {pluralize(charges.length, "separate line")}
            </span>
          </summary>
          <ul className="mt-3 divide-y divide-border/60">
            {charges.map((line) => (
              <li key={line.id} id={`extraction-source-${line.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{line.description}</span>
                  <span className="block text-2xs text-muted-foreground">
                    {line.kind} · source line {line.line_number}
                  </span>
                </span>
                <span className="text-xs tabular-nums">{line.line_total_cents == null ? "Amount unknown" : formatCurrency(line.line_total_cents, currency)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {data.purchase_eligible ? (
        <section className="surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-[1.25rem] tracking-[-0.02em]">Purchase review</h3>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                One shared purchase total is recorded for the selected items. Product line
                amounts remain review evidence and are not silently allocated as per-item
                purchase fields.
              </p>
            </div>
            {purchaseAction !== "none" && <Badge variant="brass">Purchase will change</Badge>}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Purchase action">
            {[
              ["none", "No purchase change"],
              ["create", "Create purchase"],
              ...(purchaseOptions.length > 0 ? [["existing", "Use existing purchase"]] : []),
            ].map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={purchaseAction === value ? "default" : "outline"}
                aria-pressed={purchaseAction === value}
                onClick={() => {
                  setPurchaseAction(value as "none" | "create" | "existing");
                  if (value === "existing" && purchaseOptions[0]) {
                    setPurchaseId(purchaseOptions[0].id);
                  }
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {purchaseAction === "existing" && purchaseOptions.length > 0 && (
            <div className="mt-3 space-y-2">
              <Field label="Existing purchase" htmlFor="extraction-purchase">
                <Select
                  id="extraction-purchase"
                  value={purchaseId}
                  onChange={(event) => setPurchaseId(event.target.value)}
                >
                  <option value="">Choose a purchase</option>
                  {purchaseOptions.map((purchase) => (
                    <option key={purchase.id} value={purchase.id}>
                      {[purchase.merchant, purchase.purchase_date]
                        .filter(Boolean)
                        .join(" · ") || "Existing purchase"}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-2xs">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={updatePurchaseFields}
                  onChange={(event) => setUpdatePurchaseFields(event.target.checked)}
                />
                Update this purchase&apos;s fields with the reviewed values
              </label>
            </div>
          )}
          {purchaseAction === "create" && (
            <p className="mt-3 text-2xs text-muted-foreground">
              The reviewed merchant, date, total, currency and order number will be saved as
              one purchase shared by the selected items.
            </p>
          )}
          {purchaseAction !== "none" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex items-start justify-between gap-3 text-2xs sm:col-span-2">
                <span>
                  <span className="block font-medium">Use this document as the receipt</span>
                  <span className="block text-2xs text-muted-foreground">
                    Links the document to the purchase record.
                  </span>
                </span>
                <Switch
                  checked={attachAsReceipt}
                  onCheckedChange={setAttachAsReceipt}
                  aria-label="Use this document as the receipt"
                />
              </label>
            </div>
          )}
          <label className="mt-3 flex items-start justify-between gap-3 border-t border-border/60 pt-3 text-2xs">
            <span>
              <span className="block font-medium">Link document to selected items</span>
              <span className="block text-2xs text-muted-foreground">
                Attachment links are explicit and can be changed later from the document or
                item pages.
              </span>
            </span>
            <Switch
              checked={linkDocument}
              onCheckedChange={setLinkDocument}
              aria-label="Link document to selected items"
            />
          </label>
        </section>
      ) : (
        <div className="surface p-4 text-2xs leading-relaxed text-muted-foreground">
          This document type is not treated as proof of purchase. You can review product,
          model, serial and warranty evidence, but purchase recording is disabled.
        </div>
      )}

      <details className="surface p-4 sm:p-5">
        <summary className="cursor-pointer text-xs font-medium">
          AI matching details
          <span className="ml-2 text-2xs font-normal text-muted-foreground">
            {aiStatus?.configured ? aiStatus.provider_label ?? aiStatus.provider : "not configured"}
          </span>
        </summary>
        <div className="mt-3 space-y-2 text-2xs leading-relaxed text-muted-foreground">
          <p>{aiStatus?.privacy_note ?? "No AI ranking is configured."}</p>
          <p>
            Task: documents · Mode: {aiStatus?.mode ?? "disabled"} · Model:{" "}
            {aiStatus?.model ?? "none"} · Consent:{" "}
            {aiStatus?.cloud_consent ? "cloud consented" : "cloud not consented"}.
          </p>
          {aiStatus?.error && <p className="text-brass">{aiStatus.error}</p>}
          <p>
            Field/line refinement and match re-ranking are separate explicit actions. AI
            field/line output is validated against OCR evidence before it appears here; it
            never writes inventory or overwrites the deterministic proposal. Match ranking may
            only reorder the household candidates supplied by Housetory. Exact identifier
            candidates stay ahead of vague suggestions; unknown IDs are discarded.
            Deterministic extraction/matching remains available when no provider or consent
            exists.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => queueOperation("interpret")}
              disabled={!aiAvailable || aiProcessing || matchMutation.isPending}
            >
              {queueAi.isPending && queueAi.variables === "interpret" ? <Spinner /> : <Sparkles />}
              Refine fields &amp; lines
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => queueOperation("matches")}
              disabled={!aiAvailable || aiProcessing || matchMutation.isPending}
            >
              {queueAi.isPending && queueAi.variables === "matches" ? <Spinner /> : <Wand2 />}
              Re-rank matches
            </Button>
          </div>
        </div>
      </details>

      <div className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-[1.2rem] tracking-[-0.02em]">Change preview</h3>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {createCount} create · {updateCount} update · {linkCount} link ·{" "}
              {pendingDrafts.length - selectedLineCount} not selected (stay pending)
              {purchaseAction !== "none" && selectedLineCount > 0 ? " · purchase review" : ""}
            </p>
          </div>
          <Badge variant="outline">{selectedLineCount} selected</Badge>
        </div>
        {validationErrors.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-brass/20 bg-brass-soft/40 p-3 text-2xs text-muted-foreground">
            {validationErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {applyMutation.error && <FormError message={getApiErrorMessage(applyMutation.error)} />}
        <div className="mt-4 flex flex-col-reverse gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xs text-muted-foreground">
            Nothing is created, linked, purchased or overwritten until you confirm. Everything
            in one Apply is saved together or not at all. A line that is applied is never
            applied twice, and all lines of this document share one purchase.
          </p>
          <Button
            type="button"
            onClick={() => applyLines(selectedDrafts.map((draft) => draft.line.id))}
            disabled={applyDisabled}
          >
            {applyMutation.isPending ? <Spinner /> : <Check />}
            {applyLabel}
          </Button>
        </div>
      </div>
      </div>}
    </div>
  );
}
