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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import { CURRENCIES } from "@/lib/labels";
import {
  queryKeys,
  useCanWrite,
  useInvalidateInventory,
  useItems,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type {
  AiStatus,
  CandidateItem,
  DocumentRecord,
  ExtractionApplyResponse,
  ExtractionLine,
  ExtractionLineAction,
  ExtractionLineMatch,
  ExtractionMatchResponse,
  ExtractionRefinement,
  ExtractionReview,
  ItemSummary,
} from "@/lib/types";
import { cn, formatCurrency, formatDate, pluralize } from "@/lib/utils";

type WarrantyDraft = {
  enabled: boolean;
  provider: string;
  startDate: string;
  endDate: string;
  months: string;
};

type NewItemDraft = {
  name: string;
  brand: string;
  model: string;
  serialNumber: string;
  roomId: string;
  locationId: string;
};

type UpdateDraft = {
  name: string;
  brand: string;
  model: string;
  serialNumber: string;
  roomId: string;
  locationId: string;
};

type LineDraft = {
  line: ExtractionLine;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  action: ExtractionLineAction;
  itemId: string;
  addQuantity: boolean;
  newItem: NewItemDraft;
  updates: UpdateDraft;
  warranty: WarrantyDraft;
};

function centsInput(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function parseMoney(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parseQuantity(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function fieldValue(value: string | null | undefined): string {
  return value ?? "";
}

function lineDraft(
  line: ExtractionLine,
  candidate: CandidateItem | undefined,
  fields: ExtractionReview["fields"],
  onlyLine: boolean,
): LineDraft {
  const strong = candidate && ["exact_identifier", "strong"].includes(candidate.match_quality);
  return {
    line,
    description: line.description,
    quantity: line.quantity == null ? "" : String(line.quantity),
    unitPrice: centsInput(line.unit_price_cents),
    lineTotal: centsInput(line.line_total_cents),
    action: strong ? "link" : "skip",
    itemId: strong && candidate ? candidate.id : "",
    addQuantity: false,
    newItem: {
      name: line.description,
      brand: onlyLine ? fields.brand ?? "" : "",
      model: onlyLine ? fields.model ?? "" : "",
      serialNumber: onlyLine ? fields.serial_numbers[0] ?? "" : "",
      roomId: "",
      locationId: "",
    },
    updates: {
      name: "",
      brand: "",
      model: "",
      serialNumber: "",
      roomId: "",
      locationId: "",
    },
    warranty: {
      enabled: false,
      provider: fields.warranty_provider ?? "",
      startDate: fields.warranty_start ?? "",
      endDate: fields.warranty_end ?? "",
      months: fields.warranty_months == null ? "" : String(fields.warranty_months),
    },
  };
}

function candidateFromItem(item: ItemSummary): CandidateItem {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    model: item.model,
    serial_number: null,
    quantity: item.quantity,
    on_loan_quantity: item.on_loan_quantity ?? 0,
    room_name: item.room?.name ?? null,
    location_name: item.location?.name ?? null,
    purchase: item.purchase
      ? {
          id: item.purchase.id,
          merchant: item.purchase.merchant,
          purchase_date: item.purchase.purchase_date,
          price_cents: item.purchase.price_cents,
          currency: item.purchase.currency,
        }
      : null,
    warranty: item.warranty
      ? {
          provider: item.warranty.provider,
          start_date: item.warranty.start_date,
          end_date: item.warranty.end_date,
          duration_months: item.warranty.duration_months,
        }
      : null,
    reasons: ["selected manually from the household inventory"],
    match_quality: "possible",
    exact_identifier: false,
  };
}

function qualityLabel(quality: string): string {
  if (quality === "exact_identifier") return "Exact identifier";
  if (quality === "strong") return "Strong match";
  if (quality === "possible") return "Possible match";
  return "No likely match";
}

function ItemSearchPicker({
  onSelect,
  disabled,
}: {
  onSelect: (item: ItemSummary) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const debounced = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debounced.trim() || undefined, sort: "name_asc", include_archived: false },
    20,
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-background/60 p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the household inventory"
          aria-label="Search inventory for this line"
          className="h-9 pl-8 text-[0.78rem]"
          disabled={disabled}
        />
      </div>
      <div className="mt-1 max-h-52 overflow-y-auto">
        {itemsQuery.isPending ? (
          <p className="flex items-center justify-center gap-2 py-4 text-[0.72rem] text-muted-foreground">
            <Spinner className="size-3.5" /> Searching…
          </p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-[0.72rem] text-muted-foreground">
            No item matches that search.
          </p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(item)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary/70"
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.76rem] font-medium">{item.name}</span>
                <span className="block truncate text-[0.66rem] text-muted-foreground">
                  {[item.room?.name, item.location?.name].filter(Boolean).join(" / ") ||
                    "No place"}
                  {item.purchase?.purchase_date ? ` · ${formatDate(item.purchase.purchase_date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-[0.66rem] text-muted-foreground">×{item.quantity}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function DocumentExtractionReview({ document }: { document: DocumentRecord }) {
  const canWrite = useCanWrite();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const extractionQuery = useQuery({
    queryKey: [...queryKeys.document(document.id), "extraction"],
    queryFn: () => api.get<ExtractionReview>(`/documents/${document.id}/extraction`),
    enabled: document.ocr_status === "succeeded" && Boolean(document.extracted_text),
  });
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const [drafts, setDrafts] = React.useState<LineDraft[]>([]);
  const [matches, setMatches] = React.useState<ExtractionLineMatch[]>([]);
  const [manualLineId, setManualLineId] = React.useState<string | null>(null);
  const [merchant, setMerchant] = React.useState("");
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const [documentDate, setDocumentDate] = React.useState("");
  const [currency, setCurrency] = React.useState("USD");
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
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  const [applyResult, setApplyResult] = React.useState<ExtractionApplyResponse | null>(null);
  const [activeVersion, setActiveVersion] = React.useState("");
  const [refinement, setRefinement] = React.useState<ExtractionRefinement | null>(null);
  const [refinementActive, setRefinementActive] = React.useState(false);
  const versionRef = React.useRef<string | null>(null);
  const data = extractionQuery.data;

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
    setDrafts(
      productLines.map((line) =>
        lineDraft(
          line,
          matchMap[line.id]?.candidates[0],
          fields,
          productLines.length === 1,
        ),
      ),
    );
    setMatches(proposalMatches);
    setMerchant(fieldValue(fields.merchant ?? document.merchant));
    setPurchaseDate(fieldValue(fields.purchase_date));
    setDocumentDate(fieldValue(fields.document_date ?? document.document_date));
    setCurrency(fields.currency ?? "USD");
    setTotal(centsInput(fields.total_cents));
    setOrderNumber(fieldValue(fields.order_number));
    setPurchaseAction(purchaseEligible && fields.total_cents != null ? "create" : "none");
    setPurchaseId("");
    setUpdatePurchaseFields(false);
    setAttachAsReceipt(true);
    setLinkDocument(true);
    setAllowReapply(false);
    setActiveVersion(version);
    setApplyResult(null);
    setManualLineId(null);
    setRequestId(crypto.randomUUID());
  };

  React.useEffect(() => {
    if (!data || versionRef.current === data.version) return;
    versionRef.current = data.version;
    loadProposal(
      data.fields,
      data.lines,
      data.matches,
      data.version,
      data.purchase_eligible,
    );
    setAiStatus(data.ai_status);
    setAiWarnings([]);
    setRefinement(null);
    setRefinementActive(false);
    // The proposal identity intentionally resets drafts only for a new OCR version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const matchMutation = useMutation({
    mutationFn: (useAi: boolean) =>
      api.post<ExtractionMatchResponse>(
        `/documents/${document.id}/extraction/matches`,
        {
          use_ai: useAi,
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
    onSuccess: (result, useAi) => {
      setMatches(result.matches);
      setAiStatus(result.ai_status);
      setAiWarnings(result.warnings);
      if (useAi) {
        toast.success(
          result.ai_used
            ? "AI re-ranked the household candidates"
            : "Deterministic matches were kept",
        );
      }
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const refineMutation = useMutation({
    mutationFn: () =>
      api.post<ExtractionRefinement>(
        `/documents/${document.id}/extraction/refine`,
        {},
      ),
    onSuccess: (result) => {
      setRefinement(result);
      setAiStatus(result.ai_status);
      setAiWarnings(result.warnings);
      toast.success("AI proposed a field and line refinement; review before accepting");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      api.post<ExtractionApplyResponse>(
        `/documents/${document.id}/extraction/apply`,
        buildApplyPayload({ extractionVersion: activeVersion, drafts, merchant, purchaseDate, documentDate, currency, total, orderNumber, purchaseAction, purchaseId, updatePurchaseFields, attachAsReceipt, linkDocument, allowReapply, requestId }),
      ),
    onSuccess: (result) => {
      setApplyResult(result);
      setRequestId(crypto.randomUUID());
      setAllowReapply(false);
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.document(document.id), "extraction"],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      toast.success("Reviewed extraction applied");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (document.ocr_status === "queued" || document.ocr_status === "processing") {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/20 px-4 py-5 text-[0.8rem] text-muted-foreground">
        <Spinner /> Waiting for the local OCR worker…
      </div>
    );
  }
  if (extractionQuery.isPending) {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/20 px-4 py-5 text-[0.8rem] text-muted-foreground">
        <Spinner /> Preparing the line-item proposal…
      </div>
    );
  }
  if (extractionQuery.isError) {
    return (
      <div className="mt-5 rounded-xl border border-brass/25 bg-brass-soft/40 p-4 text-[0.78rem] leading-relaxed text-muted-foreground">
        Extraction is not available yet. Retry OCR from the Local OCR panel after
        improving the scan, then review the proposal again.
      </div>
    );
  }
  if (!data) {
    return (
      <p className="mt-5 text-[0.8rem] leading-relaxed text-muted-foreground">
        Run OCR to propose document fields and product lines. Nothing is applied until you
        confirm the reviewed proposal.
      </p>
    );
  }
  if (!canWrite) {
    return (
      <div className="mt-5 rounded-xl border border-border/70 bg-secondary/25 p-4 text-[0.75rem] leading-relaxed text-muted-foreground">
        Extracted fields and matches are visible to viewers for reference. Applying changes
        requires member access.
      </div>
    );
  }

  const charges = data.lines.filter((line) => line.kind !== "product");
  const selectedPurchaseIds = new Map<string, CandidateItem["purchase"]>();
  for (const draft of drafts) {
    if (draft.action === "skip" || !draft.itemId) continue;
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

  const validationErrors: string[] = [];
  for (const draft of drafts) {
    if (draft.action === "create") {
      if (!draft.newItem.name.trim()) validationErrors.push("A new item needs a name.");
      if (!draft.newItem.roomId) validationErrors.push("A new item needs a room.");
    }
    if (draft.action === "update") {
      const hasField = Object.values(draft.updates).some((value) => value.trim());
      if (!hasField) validationErrors.push("Choose at least one field to update on an existing item.");
    }
    if ((draft.action === "link" || draft.action === "update") && !draft.itemId) {
      validationErrors.push("Choose an existing item or skip the line.");
    }
    if (draft.addQuantity && !parseQuantity(draft.quantity)) {
      validationErrors.push("Added quantity must be a whole number of at least 1.");
    }
  }
  if (purchaseAction !== "none" && drafts.every((draft) => draft.action === "skip")) {
    validationErrors.push("Choose at least one item for the purchase.");
  }
  if (purchaseAction === "existing" && !purchaseId) {
    validationErrors.push("Choose the existing purchase.");
  }
  const reapplyBlocked = data.applied.length > 0 && !allowReapply;
  const editedDocumentFields =
    merchant !== fieldValue(data.fields.merchant ?? document.merchant) ||
    documentDate !== fieldValue(data.fields.document_date ?? document.document_date);
  const selectedLineCount = drafts.filter((draft) => draft.action !== "skip").length;
  const createCount = drafts.filter((draft) => draft.action === "create").length;
  const updateCount = drafts.filter((draft) => draft.action === "update").length;
  const linkCount = drafts.filter((draft) => draft.action === "link").length;
  const skipCount = drafts.filter((draft) => draft.action === "skip").length;
  const aiAvailable = Boolean(
    aiStatus?.configured &&
      (aiStatus.mode === "local" || aiStatus.cloud_consent),
  );

  const updateDraft = (lineId: string, update: (draft: LineDraft) => LineDraft) => {
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

  const addManualCandidate = (draft: LineDraft, item: ItemSummary) => {
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
    setRefinementActive(true);
    toast.success("AI refinement added to the review draft; apply is still separate");
  };

  const rejectRefinement = () => {
    setRefinement(null);
    setRefinementActive(false);
  };

  const revertRefinement = () => {
    loadProposal(
      data.fields,
      data.lines,
      data.matches,
      data.version,
      data.purchase_eligible,
    );
    setRefinement(null);
    setRefinementActive(false);
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

  const applyDisabled =
    applyMutation.isPending ||
    reapplyBlocked ||
    validationErrors.length > 0 ||
    (purchaseAction === "none" &&
      drafts.every((draft) => draft.action === "skip") &&
      !editedDocumentFields);

  return (
    <div className="mt-5 space-y-5">
      {applyResult && (
        <div className="rounded-xl border border-sage/25 bg-sage-soft/60 p-3.5 text-[0.75rem] leading-relaxed">
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
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[0.7rem] text-brass">
              {applyResult.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {data.applied.length > 0 && (
        <div className="rounded-xl border border-brass/25 bg-brass-soft/50 p-3.5 text-[0.75rem] leading-relaxed">
          <p className="flex items-center gap-1.5 font-medium text-brass">
            <AlertTriangle className="size-3.5" /> This extraction was already applied
          </p>
          <p className="mt-1 text-muted-foreground">
            Last applied {formatDate(data.applied[0]?.applied_at ?? "")}. Retries with the
            same request id return the previous result. To intentionally create another
            purchase or stock increase, explicitly allow a re-apply.
          </p>
          <label className="mt-2 flex items-center gap-2 text-[0.72rem]">
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
        <div className="rounded-xl border border-brass/25 bg-brass-soft/40 p-3.5 text-[0.74rem] leading-relaxed text-muted-foreground">
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

      {(refinement || refinementActive) && (
        <div className="rounded-xl border border-brass/30 bg-brass-soft/35 p-3.5 text-[0.74rem] leading-relaxed">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-medium text-brass">
              <Sparkles className="size-3.5" />
              AI refinement proposal
              {refinementActive && <Badge variant="brass">Active</Badge>}
            </p>
            {refinement && (
              <span className="text-[0.66rem] text-muted-foreground">
                {refinement.ai_status.provider_label ?? refinement.ai_status.provider} ·{" "}
                {refinement.version.slice(0, 8)}
              </span>
            )}
          </div>
          <p className="mt-1 text-muted-foreground">
            AI suggestions are separate from the deterministic proposal and your edits.
            Nothing is saved until you accept the refinement and then apply the reviewed
            changes. Accepting replaces the current draft fields and lines.
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
                  <p className="mt-0.5 line-clamp-2 text-[0.66rem] text-muted-foreground">
                    {line.evidence.text}
                  </p>
                </div>
              ))}
            </div>
          )}
          {refinement?.warnings && refinement.warnings.length > 0 && (
            <p className="mt-2 text-[0.68rem] text-brass">{refinement.warnings.join(" ")}</p>
          )}
          {refineMutation.error && (
            <FormError message={getApiErrorMessage(refineMutation.error)} />
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {refinementActive ? (
              <Button type="button" size="sm" variant="outline" onClick={revertRefinement}>
                Use deterministic proposal
              </Button>
            ) : (
              <>
                <Button type="button" size="sm" onClick={acceptRefinement}>
                  <Check /> Accept AI refinement
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={rejectRefinement}>
                  Reject AI suggestion
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-secondary/20 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[0.78rem] font-medium">Extracted proposal</p>
            <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
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
          <ul className="mt-3 space-y-1.5 rounded-lg border border-brass/20 bg-brass-soft/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
            {data.warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-brass" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
        {data.fields.uncertain_fields.length > 0 && (
          <p className="mt-2 text-[0.7rem] text-brass">
            Verify uncertain fields: {data.fields.uncertain_fields.join(", ")}.
          </p>
        )}
      </div>

      <section className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-[1.25rem] tracking-[-0.02em]">Document fields</h3>
            <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
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
              <p className="mt-1 text-[0.68rem] text-muted-foreground">
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
          </Field>
          <Field label="Total" htmlFor="extraction-total" optional>
            <Input
              id="extraction-total"
              type="number"
              min={0}
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
          <p className="mt-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[0.7rem] leading-relaxed text-muted-foreground">
            Recorded subtotal{" "}
            {formatCurrency(data.fields.subtotal_cents ?? 0, currency)} · tax{" "}
            {formatCurrency(data.fields.tax_cents ?? 0, currency)} · discount{" "}
            {formatCurrency(data.fields.discount_cents ?? 0, currency)} · shipping{" "}
            {formatCurrency(data.fields.shipping_cents ?? 0, currency)}. These charge lines
            are kept separate and are not allocated to products.
          </p>
        )}
        {Object.keys(data.fields.field_sources).length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[0.7rem] text-muted-foreground">
              Field source evidence
            </summary>
            <dl className="mt-2 space-y-1.5 text-[0.68rem] text-muted-foreground">
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
            <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
              Choose likely matches first, create only the items you want, or skip lines that
              are not inventory.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => refineMutation.mutate()}
              disabled={!aiAvailable || refineMutation.isPending || drafts.length === 0}
              title={
                aiAvailable
                  ? "Ask the configured document AI to refine fields and product lines"
                  : "Configure and consent to the documents AI task first"
              }
            >
              {refineMutation.isPending ? <Spinner /> : <Sparkles />}
              Refine fields &amp; lines
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => matchMutation.mutate(false)}
              disabled={matchMutation.isPending || drafts.length === 0}
            >
              {matchMutation.isPending ? <Spinner /> : <Search />}
              Refresh matches
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => matchMutation.mutate(true)}
              disabled={!aiAvailable || matchMutation.isPending || drafts.length === 0}
              title={
                aiAvailable
                  ? "Re-rank supplied candidates with the configured document AI"
                  : "Configure and consent to the documents AI task first"
              }
            >
              <Wand2 />
              Re-rank matches
            </Button>
          </div>
        </div>

        {aiWarnings.length > 0 && (
          <div className="rounded-lg border border-brass/20 bg-brass-soft/40 px-3 py-2 text-[0.7rem] text-muted-foreground">
            {aiWarnings.join(" ")}
          </div>
        )}

        {drafts.length === 0 ? (
          <div className="surface px-4 py-6 text-[0.78rem] text-muted-foreground">
            No product lines were recognised. Review the source text and use manual search or
            create an item from the document fields if appropriate.
          </div>
        ) : (
          drafts.map((draft) => {
            const lineMatch = matchFor(draft.line.id);
            const selected = candidateFor(draft);
            const edited =
              draft.description !== draft.line.description ||
              draft.quantity !== (draft.line.quantity == null ? "" : String(draft.line.quantity)) ||
              draft.unitPrice !== centsInput(draft.line.unit_price_cents) ||
              draft.lineTotal !== centsInput(draft.line.line_total_cents);
            return (
              <article
                key={draft.line.id}
                className="surface space-y-3 p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">Line {draft.line.line_number}</Badge>
                    <Badge variant="secondary">Product</Badge>
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
                  </div>
                  <span className="text-[0.68rem] text-muted-foreground">
                    {draft.line.purchase_eligible ? "Inventory candidate" : "Review only"}
                  </span>
                </div>

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
                      min={0}
                      step="0.01"
                      value={draft.unitPrice}
                      onChange={(event) =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          unitPrice: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Line total" htmlFor={`line-total-${draft.line.id}`} optional>
                    <Input
                      id={`line-total-${draft.line.id}`}
                      type="number"
                      min={0}
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

                {draft.line.warnings.length > 0 && (
                  <ul className="space-y-1 text-[0.7rem] text-brass">
                    {draft.line.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}

                <details className="text-[0.7rem] text-muted-foreground">
                  <summary className="cursor-pointer">
                    Source line evidence
                    {draft.line.evidence.page ? ` · page ${draft.line.evidence.page}` : ""}
                  </summary>
                  <p className="mt-1 rounded-lg bg-secondary/35 px-2.5 py-2 font-mono text-[0.68rem] leading-relaxed text-foreground/70">
                    {draft.line.evidence.text}
                  </p>
                </details>

                <div className="rounded-xl border border-border/70 bg-background/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[0.75rem] font-medium">Suggested existing items</p>
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
                              <span className="text-[0.78rem] font-medium">{candidate.name}</span>
                              {candidate.exact_identifier && (
                                <Badge variant="sage">Identifier verified</Badge>
                              )}
                              <span className="text-[0.66rem] text-muted-foreground">
                                ×{candidate.quantity}
                                {candidate.on_loan_quantity
                                  ? ` · ${candidate.on_loan_quantity} on loan`
                                  : ""}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">
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
                              <span className="mt-1 block text-[0.66rem] text-brass">
                                {candidate.reasons.join(" · ")}
                              </span>
                            )}
                            {candidate.warranty && (
                              <span className="mt-0.5 block text-[0.64rem] text-muted-foreground">
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
                    <p className="mt-2 text-[0.72rem] text-muted-foreground">
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
                    <Button
                      type="button"
                      size="sm"
                      variant={draft.action === "skip" ? "default" : "outline"}
                      onClick={() =>
                        updateDraft(draft.line.id, (current) => ({
                          ...current,
                          action: "skip",
                          itemId: "",
                        }))
                      }
                    >
                      Skip line
                    </Button>
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
                              {room.name}
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
                  )}

                  {draft.action === "update" && selected && (
                    <div className="mt-3 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
                      <p className="text-[0.7rem] text-muted-foreground sm:col-span-2">
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
                              {room.name}
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

                  <label className="mt-3 flex items-start gap-2 border-t border-border/60 pt-3 text-[0.72rem]">
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
                      <span className="block text-[0.68rem] text-muted-foreground">
                        Linking a receipt does not increase an existing item&apos;s quantity
                        unless this is explicitly selected. Open loans are not changed.
                      </span>
                    </span>
                  </label>

                  {warrantySupported &&
                    ["create", "link", "update"].includes(draft.action) && (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <label className="flex items-start gap-2 text-[0.72rem]">
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
                            <span className="block text-[0.68rem] text-muted-foreground">
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
              </article>
            );
          })
        )}
      </section>

      {charges.length > 0 && (
        <details className="surface p-4 sm:p-5">
          <summary className="cursor-pointer text-[0.8rem] font-medium">
            Charges, discounts and payment lines
            <span className="ml-2 text-[0.7rem] font-normal text-muted-foreground">
              {pluralize(charges.length, "separate line")}
            </span>
          </summary>
          <ul className="mt-3 divide-y divide-border/60">
            {charges.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block text-[0.76rem] font-medium">{line.description}</span>
                  <span className="block text-[0.66rem] text-muted-foreground">
                    {line.kind} · source line {line.line_number}
                  </span>
                </span>
                <span className="text-[0.76rem] tabular-nums">{formatCurrency(line.line_total_cents ?? 0, currency)}</span>
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
              <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
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
              <label className="flex items-center gap-2 text-[0.72rem]">
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
            <p className="mt-3 text-[0.72rem] text-muted-foreground">
              The reviewed merchant, date, total, currency and order number will be saved as
              one purchase shared by the selected items.
            </p>
          )}
          {purchaseAction !== "none" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex items-start justify-between gap-3 text-[0.75rem] sm:col-span-2">
                <span>
                  <span className="block font-medium">Use this document as the receipt</span>
                  <span className="block text-[0.68rem] text-muted-foreground">
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
          <label className="mt-3 flex items-start justify-between gap-3 border-t border-border/60 pt-3 text-[0.75rem]">
            <span>
              <span className="block font-medium">Link document to selected items</span>
              <span className="block text-[0.68rem] text-muted-foreground">
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
        <div className="surface p-4 text-[0.75rem] leading-relaxed text-muted-foreground">
          This document type is not treated as proof of purchase. You can review product,
          model, serial and warranty evidence, but purchase recording is disabled.
        </div>
      )}

      <details className="surface p-4 sm:p-5">
        <summary className="cursor-pointer text-[0.8rem] font-medium">
          AI matching details
          <span className="ml-2 text-[0.7rem] font-normal text-muted-foreground">
            {aiStatus?.configured ? aiStatus.provider_label ?? aiStatus.provider : "not configured"}
          </span>
        </summary>
        <div className="mt-3 space-y-2 text-[0.72rem] leading-relaxed text-muted-foreground">
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
              onClick={() => refineMutation.mutate()}
              disabled={!aiAvailable || refineMutation.isPending}
            >
              {refineMutation.isPending ? <Spinner /> : <Sparkles />}
              Refine fields &amp; lines
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => matchMutation.mutate(true)}
              disabled={!aiAvailable || matchMutation.isPending}
            >
              {matchMutation.isPending ? <Spinner /> : <Wand2 />}
              Re-rank matches
            </Button>
          </div>
        </div>
      </details>

      <div className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-[1.2rem] tracking-[-0.02em]">Change preview</h3>
            <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
              {createCount} create · {updateCount} update · {linkCount} link · {skipCount} skip
              {purchaseAction !== "none" ? " · purchase review" : ""}
            </p>
          </div>
          <Badge variant="outline">{selectedLineCount} reviewed lines</Badge>
        </div>
        {validationErrors.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-brass/20 bg-brass-soft/40 p-3 text-[0.7rem] text-muted-foreground">
            {validationErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        {applyMutation.error && <FormError message={getApiErrorMessage(applyMutation.error)} />}
        <div className="mt-4 flex flex-col-reverse gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.68rem] text-muted-foreground">
            Nothing is created, linked, purchased or overwritten until you confirm. Apply is
            atomic; retries with the same request id are safe.
          </p>
          <Button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={applyDisabled}
          >
            {applyMutation.isPending ? <Spinner /> : <Check />}
            Apply reviewed changes
          </Button>
        </div>
      </div>
    </div>
  );
}

function buildApplyPayload({
  extractionVersion,
  drafts,
  merchant,
  purchaseDate,
  documentDate,
  currency,
  total,
  orderNumber,
  purchaseAction,
  purchaseId,
  updatePurchaseFields,
  attachAsReceipt,
  linkDocument,
  allowReapply,
  requestId,
}: {
  extractionVersion: string;
  drafts: LineDraft[];
  merchant: string;
  purchaseDate: string;
  documentDate: string;
  currency: string;
  total: string;
  orderNumber: string;
  purchaseAction: "none" | "create" | "existing";
  purchaseId: string;
  updatePurchaseFields: boolean;
  attachAsReceipt: boolean;
  linkDocument: boolean;
  allowReapply: boolean;
  requestId: string;
}) {
  const lines = drafts.map((draft) => {
    const base: Record<string, unknown> = {
      line_id: draft.line.id,
      action: draft.action,
      quantity: parseQuantity(draft.quantity),
      line_total_cents: parseMoney(draft.lineTotal),
    };
    if (draft.action === "create") {
      base.new_item = {
        name: draft.newItem.name.trim() || draft.description.trim() || "New item",
        quantity: parseQuantity(draft.quantity) ?? 1,
        brand: draft.newItem.brand.trim() || null,
        model: draft.newItem.model.trim() || null,
        serial_number: draft.newItem.serialNumber.trim() || null,
        room_id: draft.newItem.roomId,
        storage_location_id: draft.newItem.locationId || null,
      };
    } else if (draft.action === "link" || draft.action === "update") {
      base.item_id = draft.itemId;
      base.add_quantity = draft.addQuantity;
      if (draft.action === "update") {
        const updates: Record<string, unknown> = {};
        if (draft.updates.name.trim()) updates.name = draft.updates.name.trim();
        if (draft.updates.brand.trim()) updates.brand = draft.updates.brand.trim();
        if (draft.updates.model.trim()) updates.model = draft.updates.model.trim();
        if (draft.updates.serialNumber.trim()) {
          updates.serial_number = draft.updates.serialNumber.trim();
        }
        if (draft.updates.roomId) {
          updates.room_id = draft.updates.roomId;
          updates.storage_location_id = draft.updates.locationId || null;
        }
        base.updates = updates;
      }
    }
    if (draft.warranty.enabled) {
      base.warranty = {
        provider: draft.warranty.provider.trim() || null,
        start_date: draft.warranty.startDate || null,
        duration_months: draft.warranty.months ? Number(draft.warranty.months) : null,
        end_date: draft.warranty.endDate || null,
      };
    }
    return base;
  });

  const purchase =
    purchaseAction === "create" || (purchaseAction === "existing" && updatePurchaseFields)
      ? {
          merchant: merchant.trim() || null,
          purchase_date: purchaseDate || null,
          price_cents: parseMoney(total),
          currency,
          order_number: orderNumber.trim() || null,
        }
      : null;

  return {
    request_id: requestId,
    extraction_version: extractionVersion,
    document_fields: {
      merchant: merchant.trim() || null,
      document_date: documentDate || null,
    },
    purchase_action: purchaseAction,
    purchase_id: purchaseAction === "existing" ? purchaseId || null : null,
    purchase,
    attach_as_receipt: attachAsReceipt,
    link_document: linkDocument,
    allow_reapply: allowReapply,
    lines,
  };
}
