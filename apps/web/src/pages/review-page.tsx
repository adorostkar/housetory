import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ClipboardCheck,
  Eye,
  Filter,
  Search,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CaptureReviewQueue } from "@/components/capture-review-queue";
import { EmptyState } from "@/components/empty-state";
import { FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { SectionNav } from "@/components/section-nav";
import { ReviewSchedulePanel } from "@/components/review-schedule-panel";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  appendOrigin,
  itemOrigin,
  rememberListScroll,
  useRestoreListScroll,
} from "@/lib/navigation";
import {
  queryKeys,
  useAiStatus,
  useCanWrite,
  useCategories,
  useInvalidateInventory,
  useLocations,
  useProperties,
  useReviewScopeItems,
  useReviewSuggestions,
  useReviewSummary,
  useRooms,
  useSession,
} from "@/lib/queries";
import type {
  ItemSummary,
  ReviewBulkAcceptResult,
  ReviewDecision,
  ReviewRun,
  ReviewScopeType,
  ReviewSuggestion,
  ReviewSuggestionStatus,
  ReviewSuggestionType,
} from "@/lib/types";
import {
  cn,
  flattenLocations,
  locationLabel,
  locationPath,
  pluralize,
  roomPath,
} from "@/lib/utils";
import {
  SCOPES,
  STATUS_VALUES,
  TYPE_LABELS,
  TYPE_VALUES,
  aiRunSummary,
  organisationTagNames,
  reviewScopeLabel,
  stringField,
  stringList,
  timestamp,
} from "@/pages/review-page-helpers";
import { ItemPickerDialog, ItemReference, SuggestionStatusBadge } from "@/pages/review-page-parts";

export function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const canWrite = useCanWrite();
  const session = useSession();
  const isOwner = session.data?.role === "owner";
  const queryClient = useQueryClient();
  const invalidateInventory = useInvalidateInventory();
  const propertiesQuery = useProperties();
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const categoriesQuery = useCategories();
  const summaryQuery = useReviewSummary();
  const aiStatus = useAiStatus("assistant", {
    refetchOnMount: false,
  });

  const initialItemIds = (searchParams.get("item_ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100);
  const requestedScope = searchParams.get("scope_type");
  const [scopeType, setScopeType] = React.useState<ReviewScopeType>(
    requestedScope && SCOPES.some((entry) => entry.value === requestedScope)
      ? (requestedScope as ReviewScopeType)
      : initialItemIds.length
        ? "items"
        : "household",
  );
  const [scopeId, setScopeId] = React.useState(searchParams.get("scope_id") ?? "");
  const [selectedItemIds, setSelectedItemIds] = React.useState<string[]>(initialItemIds);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [includeAi, setIncludeAi] = React.useState(false);
  const [aiConfirmOpen, setAiConfirmOpen] = React.useState(false);
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  const [lastRun, setLastRun] = React.useState<ReviewRun | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const stopReview = React.useRef(false);
  const [cancelRequested, setCancelRequested] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopReview.current = true; };
  }, []);
  const rawStatusFilter = searchParams.get("status");
  const statusFilter: ReviewSuggestionStatus = STATUS_VALUES.includes(
    rawStatusFilter as ReviewSuggestionStatus,
  )
    ? (rawStatusFilter as ReviewSuggestionStatus)
    : "pending";
  const rawTypeFilter = searchParams.get("suggestion_type");
  const typeFilter: ReviewSuggestionType | "" =
    rawTypeFilter && TYPE_VALUES.includes(rawTypeFilter as ReviewSuggestionType)
      ? (rawTypeFilter as ReviewSuggestionType)
      : "";
  const qParam = (searchParams.get("q") ?? "").slice(0, 160);
  const [suggestionSearch, setSuggestionSearch] = React.useState(qParam);
  const [suggestionOffset, setSuggestionOffset] = React.useState(0);
  const debouncedQuery = useDebouncedValue(qParam, 250);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = React.useState<Set<string>>(
    new Set(),
  );
  const [editTarget, setEditTarget] = React.useState<ReviewSuggestion | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editCategoryId, setEditCategoryId] = React.useState("");
  const [compareTarget, setCompareTarget] = React.useState<ReviewSuggestion | null>(
    null,
  );

  React.useEffect(() => {
    const nextScope = searchParams.get("scope_type");
    const nextIds = (searchParams.get("item_ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (nextIds.length) {
      setScopeType("items");
      setSelectedItemIds(nextIds);
    } else if (nextScope && SCOPES.some((entry) => entry.value === nextScope)) {
      setScopeType(nextScope as ReviewScopeType);
    }
    const nextScopeId = searchParams.get("scope_id");
    if (nextScopeId) setScopeId(nextScopeId);
  }, [searchParams]);

  React.useEffect(() => {
    setSuggestionSearch(qParam);
  }, [qParam]);

  const queueFilterSignature = `${statusFilter}|${typeFilter}|${qParam}`;
  const previousQueueFilterSignature = React.useRef(queueFilterSignature);
  React.useEffect(() => {
    if (previousQueueFilterSignature.current === queueFilterSignature) return;
    previousQueueFilterSignature.current = queueFilterSignature;
    setSelectedSuggestionIds(new Set());
    setSuggestionOffset(0);
  }, [queueFilterSignature]);

  const suggestionsQuery = useReviewSuggestions({
    status: statusFilter,
    suggestion_type: typeFilter || undefined,
    q: debouncedQuery.trim() || undefined,
    limit: 50,
    offset: suggestionOffset,
  });
  const scopeItemsQuery = useReviewScopeItems(
    selectedItemIds,
    scopeType === "items",
  );
  const scopeItems = scopeItemsQuery.data?.items ?? [];
  const properties = propertiesQuery.data?.items ?? [];
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const flatLocations = flattenLocations(locations);
  const categories = categoriesQuery.data?.items ?? [];
  const selectedProperty = properties.find((entry) => entry.id === scopeId);
  const selectedRoom = rooms.find((entry) => entry.id === scopeId);
  const selectedLocation = locations.find((entry) => entry.id === scopeId);
  const selectedLocationLabel = selectedLocation
    ? selectedLocation.identifier ?? selectedLocation.name
    : null;
  const scopeLabel = reviewScopeLabel({
    scopeType,
    propertyName: selectedProperty?.name ?? null,
    roomName: selectedRoom?.name ?? null,
    containerLabel: selectedLocationLabel,
    selectedCount: selectedItemIds.length,
  });
  const originParams = new URLSearchParams();
  originParams.set("scope_type", scopeType);
  originParams.set("status", statusFilter);
  if (typeFilter) originParams.set("suggestion_type", typeFilter);
  if (qParam) originParams.set("q", qParam);
  if (scopeType === "items" && selectedItemIds.length) {
    originParams.set("item_ids", selectedItemIds.join(","));
  } else if (scopeType !== "household" && scopeType !== "items" && scopeId) {
    originParams.set("scope_id", scopeId);
  }
  const origin = itemOrigin(`/review?${originParams.toString()}`, "Review");
  const aiReady = Boolean(aiStatus.data?.configured);
  const aiProvider = aiReady
    ? aiStatus.data?.provider_label ??
      aiStatus.data?.provider ??
      "the Assistant task"
    : "the Assistant task";

  const updateUrlScope = (nextType: ReviewScopeType, nextId: string) => {
    setScopeType(nextType);
    setScopeId(nextId);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("scope_type", nextType);
        if (nextId) next.set("scope_id", nextId);
        else next.delete("scope_id");
        next.delete("item_ids");
        return next;
      },
      { replace: true },
    );
  };

  const updateQueueFilter = (
    key: "status" | "suggestion_type",
    value: string,
  ) => {
    setSelectedSuggestionIds(new Set());
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (
        (key === "status" && value === "pending") ||
        (key === "suggestion_type" && !value)
      ) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  };

  const refreshReview = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewSummary });
    void queryClient.invalidateQueries({
      queryKey: ["inventory-review", "suggestions"],
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiStatus });
  };

  const runReview = useMutation({
    mutationFn: async (resume: ReviewRun | null) => {
      if (!canWrite) throw new Error("Review changes require write access.");
      stopReview.current = false;
      setCancelRequested(false);
      let run = resume ? await api.post<ReviewRun>(`/inventory-review/runs/${resume.id}/continue`, {
        version: resume.batch_version, resume: true,
      }) : await api.post<ReviewRun>("/inventory-review/runs", {
        scope_type: scopeType,
        scope_id: scopeType === "items" || scopeType === "household" ? null : scopeId,
        item_ids: scopeType === "items" ? selectedItemIds : null,
        include_ai: includeAi,
        request_id: requestId,
      });
      while (true) {
        if (mounted.current) setLastRun(run);
        refreshReview();
        if (!run.resumable || !run.remaining_item_count || run.ai_error ||
            run.batch_state === "cancelled" || !mounted.current) break;
        if (stopReview.current) {
          run = await api.post<ReviewRun>(`/inventory-review/runs/${run.id}/cancel`, {
            version: run.batch_version,
          });
          break;
        }
        run = await api.post<ReviewRun>(`/inventory-review/runs/${run.id}/continue`, {
          version: run.batch_version,
        });
      }
      return run;
    },
    onSuccess: (run) => {
      setLastRun(run);
      setRunError(null);
      setRequestId(crypto.randomUUID());
      setSelectedSuggestionIds(new Set());
      refreshReview();
      const prefix = run.status === "partial" ? "Review paused" : "Review complete";
      toast.success(
        `${prefix}: ${pluralize(run.created_suggestion_count, "new suggestion")}, ${run.existing_suggestion_count} already queued.`,
      );
    },
    onError: (error) => {
      setRunError(getApiErrorMessage(error));
      toast.error(getApiErrorMessage(error));
    },
  });

  const applyMutation = useMutation({
    mutationFn: ({
      suggestion,
      name,
      categoryId,
    }: {
      suggestion: ReviewSuggestion;
      name?: string;
      categoryId?: string;
    }) =>
      api.post<ReviewDecision>(
        `/inventory-review/suggestions/${suggestion.id}/accept`,
        {
          ...(name ? { name } : {}),
          ...(categoryId ? { category_id: categoryId } : {}),
        },
      ),
    onSuccess: (result) => {
      invalidateInventory();
      refreshReview();
      setEditTarget(null);
      if (result.status === "applied") toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const dismissMutation = useMutation({
    mutationFn: (suggestion: ReviewSuggestion) =>
      api.post<ReviewDecision>(
        `/inventory-review/suggestions/${suggestion.id}/dismiss`,
        {},
      ),
    onSuccess: (result) => {
      refreshReview();
      toast.success(result.message);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const undoMutation = useMutation({
    mutationFn: (suggestion: ReviewSuggestion) =>
      api.post<ReviewDecision>(
        `/inventory-review/suggestions/${suggestion.id}/undo`,
        {},
      ),
    onSuccess: (result) => {
      invalidateInventory();
      refreshReview();
      if (result.status === "applied") toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const bulkAcceptMutation = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<ReviewBulkAcceptResult>(
        "/inventory-review/suggestions/bulk-accept",
        { suggestion_ids: ids },
      ),
    onSuccess: (result) => {
      invalidateInventory();
      refreshReview();
      setSelectedSuggestionIds(new Set());
      const summary = `${result.applied_count} applied, ${result.stale_count} stale, ${result.unsupported_count} advisory/skipped`;
      if (result.applied_count && !result.stale_count && !result.unsupported_count) {
        toast.success(`Bulk review applied: ${summary}.`);
      } else if (result.applied_count) {
        toast.warning(`Bulk review finished: ${summary}.`);
      } else {
        toast.error(`No bulk changes applied: ${summary}.`);
      }
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const suggestions = suggestionsQuery.data?.items ?? [];
  useRestoreListScroll(suggestions.length > 0, origin);
  const actionableIds = new Set(
    suggestions
      .filter(
        (suggestion) =>
          suggestion.status === "pending" &&
          suggestion.action_kind !== "advisory",
      )
      .map((suggestion) => suggestion.id),
  );
  const actionableIdsKey = [...actionableIds].sort().join("|");
  React.useEffect(() => {
    setSelectedSuggestionIds((current) => {
      const next = new Set([...current].filter((id) => actionableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [actionableIdsKey]);
  const actionableSuggestions = suggestions.filter(
    (suggestion) =>
      suggestion.status === "pending" && suggestion.action_kind !== "advisory",
  );
  const selectedActionable = actionableSuggestions.filter((suggestion) =>
    selectedSuggestionIds.has(suggestion.id),
  );
  const allActionableSelected =
    actionableSuggestions.length > 0 &&
    actionableSuggestions.every((suggestion) =>
      selectedSuggestionIds.has(suggestion.id),
    );
  const displayedRun = lastRun ?? summaryQuery.data?.last_run ?? null;
  const scopeMissing =
    scopeType !== "household" &&
    scopeType !== "items" &&
    !scopeId;
  const itemsScopeMissing = scopeType === "items" && selectedItemIds.length === 0;
  const canRun = canWrite && !scopeMissing && !itemsScopeMissing;

  const toggleSuggestion = (id: string) => {
    setSelectedSuggestionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRun = () => {
    setRunError(null);
    if (includeAi) {
      setAiConfirmOpen(true);
      return;
    }
    runReview.mutate(null);
  };

  const openEdit = (suggestion: ReviewSuggestion) => {
    setEditTarget(suggestion);
    setEditName(stringField(suggestion.after, "name") ?? "");
    setEditCategoryId(
      suggestion.category_id ?? stringField(suggestion.after, "category_id") ?? "",
    );
  };

  const scopeOptions = () => {
    if (scopeType === "property") {
      return (
        <Select
          aria-label="Property scope"
          value={scopeId}
          onChange={(event) => updateUrlScope("property", event.target.value)}
        >
          <option value="">Choose a property</option>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </Select>
      );
    }
    if (scopeType === "room") {
      return (
        <Select
          aria-label="Room scope"
          value={scopeId}
          onChange={(event) => updateUrlScope("room", event.target.value)}
        >
          <option value="">Choose a room</option>
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {[room.property?.name, ...roomPath(rooms, room.id).map((entry) => entry.name)]
                .filter(Boolean)
                .join(" / ")}
            </option>
          ))}
        </Select>
      );
    }
    if (scopeType === "container") {
      return (
        <Select
          aria-label="Container or place scope"
          value={scopeId}
          onChange={(event) => updateUrlScope("container", event.target.value)}
        >
          <option value="">Choose a container or place</option>
          {flatLocations.map(({ location }) => (
            <option key={location.id} value={location.id}>
              {[
                location.identifier ? `${location.identifier} · ${location.name}` : location.name,
                ...locationPath(locations, location.id)
                  .slice(0, -1)
                  .map((entry) => locationLabel(entry)),
              ]
                .filter(Boolean)
                .join(" / ")}
            </option>
          ))}
        </Select>
      );
    }
    if (scopeType === "items") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
            Choose items
          </Button>
          <span className="text-2xs text-muted-foreground">
            {selectedItemIds.length
              ? pluralize(selectedItemIds.length, "selected item")
              : "No items selected"}
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Inventory care"
        title="Review"
        description="On-demand inventory suggestions. Rule-based checks work offline; optional AI review is explicit, bounded and never changes inventory automatically."
        actions={
          <Badge variant="outline">
            <ClipboardCheck className="size-3" />
            {summaryQuery.data?.pending_count ?? 0} pending
          </Badge>
        }
      />

      <CaptureReviewQueue />

      <SectionNav
        sections={[
          { id: "review-scope", label: "Run a review" },
          ...(displayedRun ? [{ id: "latest-review", label: "Latest review" }] : []),
          { id: "review-schedule", label: "Schedule" },
          { id: "review-suggestions", label: "Suggestions" },
        ]}
      />

      <section id="review-scope" className="surface mb-5 scroll-mt-32 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
              Review scope
            </h2>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Analysis is read-only. Nothing is renamed, categorised, moved or merged
              until you explicitly apply a suggestion.
            </p>
          </div>
          <Badge variant={canWrite ? "sage" : "outline"}>
            {canWrite ? "Can review and apply" : "Read-only"}
          </Badge>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end">
          <label className="space-y-1.5 text-2xs">
            <span className="field-label">Scope</span>
            <Select
              aria-label="Review scope type"
              value={scopeType}
              disabled={!canWrite || runReview.isPending}
              onChange={(event) =>
                updateUrlScope(event.target.value as ReviewScopeType, "")
              }
            >
              {SCOPES.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
                </option>
              ))}
            </Select>
          </label>
          <div className="space-y-1.5 text-2xs">
            <span className="field-label">Scope detail</span>
            {scopeOptions()}
          </div>
          <Button
            type="button"
            disabled={!canRun || runReview.isPending}
            onClick={startRun}
          >
            {runReview.isPending ? <Spinner /> : <ClipboardCheck />}
            {runReview.isPending
              ? "Reviewing…"
              : includeAi
                ? "Review with AI"
                : "Find suggestions"}
          </Button>
        </div>
        {runReview.isPending && (
          <Button variant="outline" className="mt-3 min-h-11" disabled={cancelRequested}
            onClick={() => { stopReview.current = true; setCancelRequested(true); }}>
            {cancelRequested ? "Cancelling after current batch…" : "Cancel after current batch"}
          </Button>
        )}

        {scopeType === "items" && scopeItems.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {scopeItems.slice(0, 8).map((item) => (
              <Badge key={item.id} variant="secondary">
                {item.name}
              </Badge>
            ))}
            {scopeItems.length > 8 && (
              <Badge variant="outline">+{scopeItems.length - 8} more</Badge>
            )}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-border/60 bg-background/35 p-3.5">
          <label className="flex items-start gap-2.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={includeAi}
              disabled={!isOwner || !aiReady || runReview.isPending}
              onChange={(event) => setIncludeAi(event.target.checked)}
            />
            <span className="min-w-0 break-words">
              Include AI suggestions
              <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                Uses your configured provider; usage charges may apply.
              </span>
            </span>
          </label>
          <details className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            <summary className="min-h-11 cursor-pointer py-3">What gets sent?</summary>
            <p>Uses the household Assistant task via {aiProvider}. AI checks items missing
              a category or tags that do not already have a local category proposal.
              Each request includes up to 40
              eligible items: names, descriptions (up to 300 characters), brand/model,
              current category/tag names, and the names and internal IDs of up to
              200 household categories and 200 tags.
              Descriptions may contain personal information you entered. No photo files,
              receipts, purchase amounts, location fields, loans, private-note fields,
              borrower records or other households are included. Provider policies apply.
              Whole-scope review makes multiple paid requests as needed; cancellation stops
              after the current batch. Opening Review sends nothing. Only the owner can
              enable AI; configured cloud consent still applies.</p>
          </details>
          {!aiReady && isOwner && (
            <p className="mt-2 text-2xs text-muted-foreground">
              The Assistant task is not configured for this household. Offline checks
              remain available.{" "}
              <Link to="/settings/ai" className="underline underline-offset-4">
                Configure AI providers
              </Link>
            </p>
          )}
          {!isOwner && (
            <p className="mt-2 text-2xs text-muted-foreground">
              Only the owner can enable the optional AI review pass. Offline review is
              still available to writers.
            </p>
          )}
        </div>
        {!canWrite && (
          <p className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
            Viewers can read suggestions but cannot run reviews, apply, dismiss or undo.
          </p>
        )}
        {runError && <div className="mt-3"><FormError message={runError} /></div>}
      </section>

      {displayedRun && (
        <section id="latest-review" className="surface mb-5 scroll-mt-32 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Latest review
              </p>
              <p className="mt-1 text-xs font-medium">
                {displayedRun.scope_label} · {timestamp(displayedRun.completed_at ?? displayedRun.created_at)}
              </p>
            </div>
            <Badge
              variant={
                displayedRun.status === "completed"
                  ? "sage"
                  : displayedRun.status === "partial"
                    ? "brass"
                    : "destructive"
              }
            >
              {displayedRun.status}
            </Badge>
          </div>
          <p className="mt-3 text-sm font-medium" role="status">
            Reviewed {displayedRun.item_count_scanned}
            {displayedRun.item_count_scanned < displayedRun.total_item_count
              ? ` of ${displayedRun.total_item_count}` : ""} items locally ·{" "}
            {displayedRun.created_suggestion_count + displayedRun.existing_suggestion_count} suggestions
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {displayedRun.include_ai
              ? displayedRun.ai_coverage_recorded
                ? `AI reviewed ${displayedRun.ai_reviewed_count} of ${displayedRun.ai_eligible_count} eligible items scanned so far.`
                : `AI reviewed ${displayedRun.ai_reviewed_count ?? (displayedRun.ai_error ? 0 : displayedRun.ai_item_count)} items. Full AI eligibility was not recorded for this older run.`
              : "AI not included. Local checks only."}
          </p>
          {displayedRun.resumable && (
            <div className="mt-3 space-y-2">
              <progress className="h-2 w-full" aria-label="Local review coverage"
                max={Math.max(1, displayedRun.total_item_count)}
                value={displayedRun.item_count_scanned} />
              <p className="text-2xs text-muted-foreground">
                {displayedRun.completed_batch_count ?? 0} batches completed ·{" "}
                {displayedRun.remaining_item_count ?? 0} items unfinished.
                {" "}Progress is saved. Leaving this page pauses after the current batch.
              </p>
              {!runReview.isPending && Boolean(displayedRun.remaining_item_count) && (
                <Button variant="outline" className="min-h-11"
                  disabled={!canWrite || (displayedRun.include_ai && !isOwner)}
                  onClick={() => runReview.mutate(displayedRun)}>Resume review</Button>
              )}
            </div>
          )}
          <details className="mt-2 text-2xs text-muted-foreground">
            <summary className="min-h-11 cursor-pointer py-3">Review details</summary>
            <p>{aiRunSummary(displayedRun)}.</p>
            <p>
            Suggestions: {displayedRun.created_suggestion_count} new ·{" "}
            {displayedRun.existing_suggestion_count} already queued ·{" "}
            {displayedRun.suppressed_suggestion_count} previously resolved ·{" "}
            {displayedRun.stale_suggestion_count} marked stale.
            </p>
            <p>{displayedRun.ai_item_count} input records selected across AI batch attempts,
              including failed or retried batches.
              {" "}{displayedRun.unavailable_item_count ?? 0} items became unavailable.</p>
          </details>
          {displayedRun.partial_reason && (
            <p className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
              Partial scan: {displayedRun.partial_reason}
            </p>
          )}
          {displayedRun.ai_error && (
            <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2 text-2xs leading-relaxed text-destructive">
              AI review: {displayedRun.ai_error}
            </p>
          )}
        </section>
      )}

      {summaryQuery.data?.unfinished_runs?.some((run) => run.id !== displayedRun?.id) && (
        <section className="surface mb-5 space-y-3 p-4 sm:p-5" aria-label="Unfinished reviews">
          <h2 className="text-sm font-medium">Unfinished reviews</h2>
          {summaryQuery.data.unfinished_runs.filter((run) => run.id !== displayedRun?.id).map((run) => (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 text-2xs">
              <span>{run.scope_label} · {run.item_count_scanned} of {run.total_item_count} scanned locally</span>
              <Button variant="outline" className="min-h-11" disabled={runReview.isPending || !canWrite || (run.include_ai && !isOwner)}
                onClick={() => runReview.mutate(run)}>Resume review</Button>
            </div>
          ))}
        </section>
      )}

      <div id="review-schedule" className="scroll-mt-32">
      {summaryQuery.isPending || summaryQuery.data?.schedule?.configured ? (
        <ReviewSchedulePanel
          isOwner={isOwner}
          schedule={summaryQuery.data?.schedule}
          onChanged={refreshReview}
        />
      ) : (
        <details
          className="group surface mb-5 p-4 sm:p-5"
          data-testid="review-schedule-advanced"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground">
            <span className="flex items-center gap-2">
              Advanced · Scheduled review
              <Badge variant="outline">Off by default</Badge>
            </span>
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3">
            <ReviewSchedulePanel
              isOwner={isOwner}
              schedule={summaryQuery.data?.schedule}
              onChanged={refreshReview}
              embedded
            />
          </div>
        </details>
      )}
      </div>

      <section id="review-suggestions" className="surface scroll-mt-32 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5 text-2xs">
            <span className="field-label">Status</span>
            <Select
              aria-label="Filter suggestions by status"
              value={statusFilter}
              onChange={(event) =>
                updateQueueFilter("status", event.target.value)
              }
            >
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="dismissed">Dismissed</option>
              <option value="stale">Stale</option>
              <option value="reverted">Undone</option>
            </Select>
          </label>
          <label className="space-y-1.5 text-2xs">
            <span className="field-label">Type</span>
            <Select
              aria-label="Filter suggestions by type"
              value={typeFilter}
              onChange={(event) =>
                updateQueueFilter("suggestion_type", event.target.value)
              }
            >
              <option value="">All types</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={suggestionSearch}
              maxLength={160}
              onChange={(event) => {
                const value = event.target.value.slice(0, 160);
                setSuggestionSearch(value);
                setSelectedSuggestionIds(new Set());
                setSearchParams(
                  (previous) => {
                    const next = new URLSearchParams(previous);
                    if (value) next.set("q", value);
                    else next.delete("q");
                    return next;
                  },
                  { replace: true },
                );
              }}
              placeholder="Search suggestions"
              aria-label="Search suggestions"
              className="pl-10"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedSuggestionIds(new Set());
              setSuggestionSearch("");
              setSearchParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete("status");
                next.delete("suggestion_type");
                next.delete("q");
                return next;
              });
            }}
          >
            <Filter />
            Reset filters
          </Button>
        </div>

        {suggestionsQuery.isPending ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        ) : suggestionsQuery.isError ? (
          <div className="mt-4">
            <FormError message={getApiErrorMessage(suggestionsQuery.error)} />
          </div>
        ) : suggestions.length === 0 ? (
          <EmptyState
            title={statusFilter === "pending" ? "Nothing waiting for review." : "No suggestions match."}
            description={
              statusFilter === "pending"
                ? "Run an on-demand review after inventory changes. Repeating an unchanged review will not flood the queue."
                : "Try another status, type or search."
            }
            className="py-12"
          />
        ) : (
          <>
            {actionableSuggestions.length > 0 && canWrite && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brass/25 bg-brass-soft/25 px-3.5 py-3 text-2xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={allActionableSelected}
                    onChange={() =>
                      setSelectedSuggestionIds(
                        allActionableSelected
                          ? new Set()
                          : new Set(actionableSuggestions.map((entry) => entry.id)),
                      )
                    }
                  />
                  <span>
                    Select all actionable pending ({actionableSuggestions.length})
                  </span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    selectedActionable.length === 0 || bulkAcceptMutation.isPending
                  }
                  onClick={() =>
                    bulkAcceptMutation.mutate(
                      selectedActionable.map((entry) => entry.id),
                    )
                  }
                >
                  {bulkAcceptMutation.isPending ? <Spinner /> : <Check />}
                  Accept selected ({selectedActionable.length})
                </Button>
              </div>
            )}

            <ul className="mt-4 space-y-3">
              {suggestions.map((suggestion) => {
                const actionable =
                  suggestion.status === "pending" &&
                  suggestion.action_kind !== "advisory";
                const categoryName =
                  stringField(suggestion.after, "category_name") ??
                  stringField(suggestion.after, "name");
                const beforeName = stringField(suggestion.before, "name");
                const proposedTags =
                  suggestion.type === "organisation"
                    ? organisationTagNames(suggestion.after)
                    : [];
                const evidence = suggestion.evidence ?? {};
                const missingFields = stringList(evidence.missing_fields);
                const mentionedRoom = stringField(evidence, "mentioned_room");
                const assignedRoom = stringField(evidence, "assigned_room");
                return (
                  <li
                    key={suggestion.id}
                    className={cn(
                      "rounded-xl border border-border/60 bg-background/35 p-4",
                      suggestion.status === "stale" && "border-destructive/25",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {actionable && canWrite && (
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={selectedSuggestionIds.has(suggestion.id)}
                              onChange={() => toggleSuggestion(suggestion.id)}
                              aria-label={`Select ${suggestion.title}`}
                            />
                          )}
                          <SuggestionStatusBadge suggestion={suggestion} />
                        </div>
                        <h3 className="mt-2 text-sm font-medium">
                          {suggestion.title}
                        </h3>
                        <p className="mt-1 max-w-3xl text-2xs leading-relaxed text-muted-foreground">
                          {suggestion.explanation}
                        </p>
                      </div>
                      <span className="text-2xs text-muted-foreground">
                        {timestamp(suggestion.created_at)}
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 text-2xs">
                      {suggestion.item && (
                        <span className="rounded-lg border border-border/60 bg-card/45 px-2.5 py-1.5">
                          <ItemReference item={suggestion.item} origin={origin} />
                        </span>
                      )}
                      {suggestion.secondary_item && (
                        <span className="rounded-lg border border-border/60 bg-card/45 px-2.5 py-1.5">
                          Compare with{" "}
                          <ItemReference item={suggestion.secondary_item} origin={origin} />
                        </span>
                      )}
                      {categoryName && (
                        <Badge variant="outline">
                          {suggestion.type === "organisation"
                            ? `Category: ${categoryName}${suggestion.after.category_is_new === true ? " (new)" : ""}`
                            : `Proposed: ${categoryName}`}
                        </Badge>
                      )}
                      {proposedTags.length > 0 && (
                        <Badge variant="outline">Tags: {proposedTags.join(", ")}</Badge>
                      )}
                      {suggestion.type === "name" && beforeName && (
                        <Badge variant="secondary">
                          “{beforeName}” → “{categoryName}”
                        </Badge>
                      )}
                      {missingFields.length > 0 && (
                        <Badge variant="outline">
                          Missing: {missingFields.join(", ")}
                        </Badge>
                      )}
                      {mentionedRoom && assignedRoom && (
                        <Badge variant="outline">
                          Mentions {mentionedRoom} · assigned {assignedRoom}
                        </Badge>
                      )}
                      {suggestion.type === "possible_duplicate" && (
                        <Badge variant="outline">
                          {evidence.serial_match === true
                            ? "Matching serial"
                            : "Same name/brand/model"}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {suggestion.status === "pending" &&
                        suggestion.action_kind === "apply_category" && (
                          <>
                            <Button
                              size="sm"
                              disabled={!canWrite || applyMutation.isPending}
                              onClick={() => applyMutation.mutate({ suggestion })}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canWrite}
                              onClick={() => openEdit(suggestion)}
                            >
                              Edit & accept
                            </Button>
                          </>
                        )}
                      {suggestion.status === "pending" &&
                        suggestion.action_kind === "apply_name" && (
                          <>
                            <Button
                              size="sm"
                              disabled={!canWrite || applyMutation.isPending}
                              onClick={() => applyMutation.mutate({ suggestion })}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canWrite}
                              onClick={() => openEdit(suggestion)}
                            >
                              Edit & accept
                            </Button>
                          </>
                        )}
                      {suggestion.status === "pending" &&
                        suggestion.action_kind === "apply_organisation" && (
                          <Button
                            size="sm"
                            disabled={!canWrite || applyMutation.isPending}
                            onClick={() => applyMutation.mutate({ suggestion })}
                          >
                            Accept organisation
                          </Button>
                        )}
                      {suggestion.status === "pending" &&
                        suggestion.action_kind === "advisory" &&
                        suggestion.type === "possible_duplicate" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setCompareTarget(suggestion)}
                          >
                            <Eye />
                            Compare
                          </Button>
                        )}
                      {suggestion.item && (
                        <Button size="sm" variant="ghost" asChild>
                          <Link
                            to={appendOrigin(`/items/${suggestion.item.id}`, origin)}
                            onClick={() => rememberListScroll(origin ?? null)}
                          >
                            Open item
                            <ArrowRight />
                          </Link>
                        </Button>
                      )}
                      {suggestion.status === "pending" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canWrite || dismissMutation.isPending}
                          onClick={() => dismissMutation.mutate(suggestion)}
                        >
                          Dismiss
                        </Button>
                      )}
                      {suggestion.status === "stale" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canWrite || dismissMutation.isPending}
                          onClick={() => dismissMutation.mutate(suggestion)}
                        >
                          Dismiss stale
                        </Button>
                      )}
                      {suggestion.status === "accepted" && suggestion.can_undo && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canWrite || undoMutation.isPending}
                          onClick={() => undoMutation.mutate(suggestion)}
                        >
                          <Undo2 />
                          Undo
                        </Button>
                      )}
                      {suggestion.status === "accepted" &&
                        !suggestion.can_undo &&
                        suggestion.undo_blocked_reason && (
                          <span className="text-2xs text-muted-foreground">
                            {suggestion.undo_blocked_reason}
                          </span>
                        )}
                      {suggestion.status === "reverted" && (
                        <Badge variant="secondary">Undone</Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
              <span>{suggestionOffset + 1}–{suggestionOffset + suggestions.length} of {suggestionsQuery.data?.total ?? suggestions.length} suggestions</span>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="min-h-11" disabled={suggestionOffset === 0 || suggestionsQuery.isFetching}
                  onClick={() => { setSuggestionOffset((value) => Math.max(0, value - 50)); setSelectedSuggestionIds(new Set()); }}>
                  Previous suggestions
                </Button>
                <Button variant="outline" className="min-h-11"
                  disabled={suggestionOffset + suggestions.length >= (suggestionsQuery.data?.total ?? 0) || suggestionsQuery.isFetching}
                  onClick={() => { setSuggestionOffset((value) => value + 50); setSelectedSuggestionIds(new Set()); }}>
                  Next suggestions
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={aiConfirmOpen}
        onOpenChange={setAiConfirmOpen}
        title="Include AI suggestions?"
        description={`Review ${scopeLabel} with your configured provider, ${aiProvider}, in batches of up to 40 eligible items. Usage charges may apply for each batch. You can cancel after the current batch and resume later. Nothing changes until you approve a suggestion.`}
        confirmLabel="Run review with AI"
        onConfirm={async () => {
          await runReview.mutateAsync(null);
        }}
      />

      <Dialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit before accepting</DialogTitle>
            <DialogDescription>
              The server rechecks the item version and proposed values before applying.
            </DialogDescription>
          </DialogHeader>
          {editTarget?.type === "category" ? (
            <label className="space-y-1.5 text-xs">
              <span className="field-label">Category</span>
              <Select
                aria-label="Proposed category"
                value={editCategoryId}
                onChange={(event) => setEditCategoryId(event.target.value)}
              >
                <option value="">Choose a category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <label className="space-y-1.5 text-xs">
              <span className="field-label">Proposed name</span>
              <Input
                aria-label="Proposed name"
                value={editName}
                maxLength={200}
                onChange={(event) => setEditName(event.target.value)}
              />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={applyMutation.isPending}
              onClick={() => {
                if (!editTarget) return;
                applyMutation.mutate({
                  suggestion: editTarget,
                  ...(editTarget.type === "category"
                    ? { categoryId: editCategoryId }
                    : { name: editName.trim() }),
                });
              }}
            >
              {applyMutation.isPending ? <Spinner /> : <Check />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(compareTarget)}
        onOpenChange={(open) => {
          if (!open) setCompareTarget(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Compare possible duplicates</DialogTitle>
            <DialogDescription>
              Housetory does not merge inventory from this review. Compare quantities,
              serials, condition, placement and active loans, then edit records individually.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {[compareTarget?.item, compareTarget?.secondary_item].filter(
              (item): item is ItemSummary => Boolean(item),
            ).map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-border/60 bg-background/35 p-3.5 text-2xs"
              >
                <p className="font-medium">{item.name}</p>
                <dl className="mt-2 space-y-1 text-muted-foreground">
                  <div>Quantity: {item.quantity}</div>
                  <div>Brand/model: {[item.brand, item.model].filter(Boolean).join(" · ") || "None"}</div>
                  <div>Place: {[item.room?.name, item.location?.name].filter(Boolean).join(" / ") || "None"}</div>
                  <div>On loan: {item.on_loan_quantity ?? 0}</div>
                  <div>Category: {item.category?.name ?? "Uncategorised"}</div>
                </dl>
                <Button size="sm" variant="outline" asChild className="mt-3">
                  <Link
                    to={appendOrigin(`/items/${item.id}`, origin)}
                    onClick={() => rememberListScroll(origin ?? null)}
                  >
                    Open item
                  </Link>
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setCompareTarget(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ItemPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={selectedItemIds}
        onConfirm={(ids) => {
          setSelectedItemIds(ids);
          setScopeType("items");
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              next.set("scope_type", "items");
              next.delete("scope_id");
              if (ids.length) next.set("item_ids", ids.join(","));
              else next.delete("item_ids");
              return next;
            },
            { replace: true },
          );
        }}
      />
    </div>
  );
}
