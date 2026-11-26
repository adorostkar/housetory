import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  FileText,
  Paperclip,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { FormError } from "@/components/form-field";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CURRENCIES } from "@/lib/labels";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  useCanWrite,
  useDefaultCurrency,
  useLocations,
  useProperties,
  useRooms,
} from "@/lib/queries";
import type {
  InsuranceBatch,
  InsuranceJob,
  InsuranceScopeItem,
  InsuranceScopePreview,
  ItemValuationPreview,
} from "@/lib/types";
import { cn, formatCurrency, formatDate, pluralize } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";

type ScopeType = "household" | "property" | "room" | "container" | "items";
type Step = "scope" | "review" | "export";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "scope", label: "Scope" },
  { id: "review", label: "Review" },
  { id: "export", label: "Export" },
];
type DraftValue = {
  amount: string;
  estimateId: string | null;
  fingerprint: string;
  estimate: ItemValuationPreview | null;
  dirty: boolean;
};

function requestId() {
  return crypto.randomUUID();
}

export function InsurancePage() {
  const [searchParams] = useSearchParams();
  const deepLinkedIds = (searchParams.get("item_ids") ?? "").split(",").filter(Boolean);
  const defaultCurrency = useDefaultCurrency();
  const canWrite = useCanWrite();
  const propertiesQuery = useProperties();
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const [scopeType, setScopeType] = React.useState<ScopeType>(
    deepLinkedIds.length ? "items" : "household",
  );
  const [scopeId, setScopeId] = React.useState("");
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [reviewedOn, setReviewedOn] = React.useState(
    new Date().toISOString().slice(0, 10),
  );
  const [includeWeb, setIncludeWeb] = React.useState(false);
  const [preview, setPreview] = React.useState<InsuranceScopePreview | null>(null);
  const [included, setIncluded] = React.useState<Set<string>>(new Set());
  const [drafts, setDrafts] = React.useState<Record<string, DraftValue>>({});
  const [batch, setBatch] = React.useState<InsuranceBatch | null>(null);
  const [list, setList] = React.useState<InsuranceJob | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<Step>("scope");
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const properties = propertiesQuery.data?.items ?? [];
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];

  React.useEffect(() => {
    if (defaultCurrency) setCurrency(defaultCurrency);
  }, [defaultCurrency]);

  const scope = React.useMemo(() => {
    if (scopeType === "household") return { include_home: true };
    if (scopeType === "items") return { item_ids: deepLinkedIds };
    if (scopeType === "property") {
      return {
        room_ids: rooms.filter((room) => room.property_id === scopeId).map((room) => room.id),
      };
    }
    if (scopeType === "room") return { room_ids: scopeId ? [scopeId] : [] };
    return { container_ids: scopeId ? [scopeId] : [] };
  }, [scopeType, scopeId, deepLinkedIds, rooms]);

  const loadPreview = useMutation({
    mutationFn: () =>
      api.post<InsuranceScopePreview>("/insurance-valuations/scope-preview", {
        scope,
        include_archived: includeArchived,
      }),
    onSuccess: (result) => {
      setPreview(result);
      setIncluded(new Set(result.items.map((item) => item.item_id)));
      setDrafts(
        Object.fromEntries(
          result.items.map((item) => [
            item.item_id,
            {
              amount: "",
              estimateId: null,
              fingerprint: item.valuation_fingerprint,
              estimate: null,
              dirty: false,
            },
          ]),
        ),
      );
      setBatch(null);
      setList(null);
      setError(null);
      setStep("review");
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  // A review belongs to the scope it was loaded for. When the scope changes,
  // the old review is dropped so that it cannot be exported by mistake.
  const dropReview = () => {
    setPreview(null);
    setBatch(null);
    setList(null);
    setError(null);
  };

  React.useEffect(() => {
    if (deepLinkedIds.length) loadPreview.mutate();
    // Load only the initial explicit selection; other scopes are deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const batchTerminal = batch
    ? ["completed", "partial", "cancelled"].includes(batch.status)
    : true;
  const batchQuery = useQuery({
    queryKey: queryKeys.insuranceBatch(batch?.request_id),
    queryFn: () =>
      api.get<InsuranceBatch>(`/insurance-valuations/batches/${batch!.request_id}`),
    enabled: Boolean(batch?.request_id) && !batchTerminal,
    refetchInterval: 1000,
  });
  React.useEffect(() => {
    if (batchQuery.data) setBatch(batchQuery.data);
  }, [batchQuery.data]);

  React.useEffect(() => {
    if (!batch) return;
    for (const entry of batch.items) {
      if (!entry.estimate) continue;
      const estimate = entry.estimate;
      setDrafts((current) => {
        const draft = current[entry.item_id];
        if (!draft || draft.dirty) return current;
        return {
          ...current,
          [entry.item_id]: {
            ...draft,
            amount: (estimate.suggested_cents / 100).toFixed(2),
            estimateId: estimate.estimate_id,
            fingerprint: estimate.fingerprint,
            estimate,
          },
        };
      });
    }
  }, [batch]);

  const listQuery = useQuery({
    queryKey: queryKeys.insuranceList(list?.id),
    queryFn: () => api.get<InsuranceJob>(`/insurance-lists/${list!.id}`),
    enabled: Boolean(list?.id) && list?.status !== "succeeded" && list?.status !== "failed" && list?.status !== "cancelled",
    refetchInterval: 1000,
  });
  React.useEffect(() => {
    if (listQuery.data) setList(listQuery.data);
  }, [listQuery.data]);

  const startBatch = useMutation({
    mutationFn: (itemIds: string[]) =>
      api.post<InsuranceBatch>("/insurance-valuations/batches", {
        item_ids: itemIds,
        currency,
        include_web: includeWeb,
        request_id: requestId(),
      }),
    onSuccess: (result) => {
      setBatch(result);
      setError(null);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const createList = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post<InsuranceJob>("/insurance-lists", payload),
    onSuccess: (result) => {
      setList(result);
      setError(null);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const rows = preview?.items ?? [];
  const eligibleIds = rows
    .filter((item) => included.has(item.item_id) && item.ai_eligible)
    .map((item) => item.item_id)
    .slice(0, 10);
  const batchRunning = Boolean(batch && !batchTerminal);

  const updateAmount = (item: InsuranceScopeItem, amount: string) => {
    setDrafts((current) => ({
      ...current,
      [item.item_id]: { ...current[item.item_id]!, amount, dirty: true },
    }));
    setList(null);
  };

  const submitList = () => {
    setError(null);
    const itemIds = rows.filter((item) => included.has(item.item_id)).map((item) => item.item_id);
    if (!itemIds.length) {
      setError("Include at least one item in the insurance list.");
      return;
    }
    const values = [];
    for (const item of rows) {
      if (!included.has(item.item_id)) continue;
      const draft = drafts[item.item_id];
      if (!draft || draft.amount.trim() === "") continue;
      const cents = Math.round(Number(draft.amount) * 100);
      if (!Number.isFinite(cents) || cents < 0 || cents > 10 ** 12) {
        setError(`Enter a valid replacement amount for ${item.name}.`);
        return;
      }
      if (cents * item.quantity > 10 ** 12) {
        setError(`The extended replacement total for ${item.name} is too large.`);
        return;
      }
      if (draft.fingerprint !== item.valuation_fingerprint) {
        setError(`${item.name} changed after valuation. Refresh the scope review.`);
        return;
      }
      values.push({
        item_id: item.item_id,
        estimate_id: draft.estimateId,
        expected_fingerprint: draft.fingerprint,
        amount_cents: cents,
      });
    }
    createList.mutate({
      item_ids: itemIds,
      currency,
      reviewed_on: reviewedOn,
      values,
      request_id: requestId(),
    });
  };

  const includedRows = rows.filter((item) => included.has(item.item_id));
  const summary = { units: 0, valued: 0, unknown: 0, invalid: 0, totalCents: 0 };
  for (const item of includedRows) {
    summary.units += item.quantity;
    const amount = drafts[item.item_id]?.amount.trim() ?? "";
    if (amount === "") {
      summary.unknown += 1;
      continue;
    }
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      summary.invalid += 1;
      continue;
    }
    summary.valued += 1;
    summary.totalCents += cents * item.quantity;
  }
  const listBusy =
    createList.isPending ||
    Boolean(list && list.status !== "succeeded" && list.status !== "failed" && list.status !== "cancelled");

  return (
    <PageLayout
      header={{
        eyebrow: "Insurance",
        title: "Create insurance list",
        description: "Review replacement values only for this dated export. Nothing is written back to your item records.",
      }}
    >
      <ol aria-label="Insurance list steps" className="mb-4 flex flex-wrap items-center gap-1 text-xs">
        {STEPS.map((entry, index) => {
          const current = step === entry.id;
          const reachable = entry.id === "scope" || Boolean(preview);
          return (
            <li key={entry.id} className="flex items-center gap-1">
              {index > 0 && (
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              )}
              <button
                type="button"
                disabled={!reachable}
                aria-current={current ? "step" : undefined}
                onClick={() => setStep(entry.id)}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-full px-3.5 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  current
                    ? "bg-primary text-primary-foreground"
                    : reachable
                      ? "text-foreground hover:bg-secondary"
                      : "text-muted-foreground",
                )}
              >
                <span className="tabular-nums" aria-hidden="true">{index + 1}</span>
                <span className="sr-only">Step {index + 1}:</span>
                {entry.label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === "scope" ? (
        <section className="surface mb-5 p-4 sm:p-5" aria-label="Scope">
          <h2 className="font-display text-xl">What should the list cover?</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select aria-label="Insurance scope" value={scopeType} onChange={(event) => {
              setScopeType(event.target.value as ScopeType);
              setScopeId("");
              dropReview();
            }}>
              <option value="household">Whole household</option>
              <option value="property">Property</option>
              <option value="room">Room</option>
              <option value="container">Container or place</option>
              {deepLinkedIds.length > 0 && <option value="items">Selected items</option>}
            </Select>
            {scopeType !== "household" && scopeType !== "items" && (
              <Select aria-label="Insurance scope detail" value={scopeId} onChange={(event) => {
                setScopeId(event.target.value);
                dropReview();
              }}>
                <option value="">Choose…</option>
                {scopeType === "property" && properties.map((property) => (
                  <option key={property.id} value={property.id}>{property.name}</option>
                ))}
                {scopeType === "room" && rooms.map((room) => (
                  <option key={room.id} value={room.id}>{room.name}</option>
                ))}
                {scopeType === "container" && locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.identifier ? `${location.identifier} · ` : ""}{location.name}
                  </option>
                ))}
              </Select>
            )}
            <Select aria-label="Insurance currency" value={currency} onChange={(event) => {
              setCurrency(event.target.value);
              setBatch(null);
              setList(null);
            }}>
              {CURRENCIES.map((code) => <option key={code}>{code}</option>)}
            </Select>
            <Input aria-label="Reviewed on" type="date" value={reviewedOn} onChange={(event) => {
              setReviewedOn(event.target.value);
              setList(null);
            }} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" className="size-4" checked={includeArchived} onChange={(event) => {
                setIncludeArchived(event.target.checked);
                dropReview();
              }} />
              Include archived
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" className="size-4" checked={includeWeb} onChange={(event) => {
                setIncludeWeb(event.target.checked);
                setBatch(null);
              }} />
              Use public comparisons where available
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button className="h-11" disabled={loadPreview.isPending || (scopeType !== "household" && scopeType !== "items" && !scopeId)} onClick={() => loadPreview.mutate()}>
              {loadPreview.isPending ? <Spinner /> : <FileText />}
              Review inventory
            </Button>
            {preview && (
              <Button variant="ghost" className="h-11" onClick={() => setStep("review")}>
                Back to the review
                <ArrowRight />
              </Button>
            )}
          </div>
        </section>
      ) : preview ? (
        <section
          className="surface mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 sm:px-5"
          aria-label="Scope"
        >
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{preview.scope_label}</span> ·{" "}
            {pluralize(rows.length, "item")} · {currency} · reviewed {formatDate(reviewedOn)}
            {includeArchived ? " · archived included" : ""}
            {preview.archived_excluded_count > 0
              ? ` · ${preview.archived_excluded_count} archived left out`
              : ""}
          </p>
          <Button variant="outline" size="sm" className="h-11" onClick={() => setStep("scope")}>
            Change scope
          </Button>
        </section>
      ) : null}

      {error && <div className="mb-5"><FormError message={error} /></div>}

      {step === "review" && preview && (
        <section className="surface overflow-hidden" aria-label="Review">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4 sm:p-5">
            <div>
              <h2 className="font-display text-xl">{preview.scope_label}</h2>
              <p className="mt-1 text-2xs text-muted-foreground">
                {rows.length} items · values per owned unit · blank means unknown
              </p>
              <p className="mt-1 text-2xs text-muted-foreground">
                AI estimates process up to 10 eligible items per batch.
              </p>
            </div>
            {canWrite && (
              <Button
                className="h-11"
                disabled={!eligibleIds.length || startBatch.isPending || batchRunning}
                onClick={() => startBatch.mutate(eligibleIds)}
              >
                {startBatch.isPending || batchRunning ? <Spinner /> : <Sparkles />}
                {batchRunning ? "Estimating…" : `Estimate ${eligibleIds.length || "eligible"} with AI`}
              </Button>
            )}
          </div>
          {rows.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground sm:p-5">
              No items are in this scope. Change the scope to go on.
            </p>
          )}
          <div className="divide-y divide-border/60">
            {rows.map((item) => {
              const draft = drafts[item.item_id]!;
              const checked = included.has(item.item_id);
              const cents = draft.amount.trim() ? Math.round(Number(draft.amount) * 100) : null;
              const batchError = batch?.items.find((entry) => entry.item_id === item.item_id)?.error;
              return (
                <div key={item.item_id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_150px_130px] sm:items-start sm:p-5">
                  <div className="flex items-start gap-1">
                    <label className="-ml-3 -mt-2.5 flex size-11 shrink-0 cursor-pointer items-center justify-center">
                      <input
                        className="size-4 accent-primary"
                        type="checkbox"
                        aria-label={`Include ${item.name}`}
                        checked={checked}
                        onChange={() => {
                          setIncluded((current) => {
                            const next = new Set(current);
                            if (next.has(item.item_id)) next.delete(item.item_id);
                            else next.add(item.item_id);
                            return next;
                          });
                          setList(null);
                        }}
                      />
                    </label>
                    <div className="min-w-0">
                      <p className="break-words font-medium">{item.name}</p>
                      <p className="mt-0.5 text-2xs text-muted-foreground">
                        {[item.brand, item.model].filter(Boolean).join(" · ") || "No brand/model"} · {item.quantity} owned
                      </p>
                      {!item.ai_eligible && <p className="mt-1 text-2xs text-brass">{item.ai_ineligible_reason}</p>}
                      {batchError && <p className="mt-1 text-2xs text-destructive">{batchError}</p>}
                      {draft.estimate && (
                        <details className="mt-1 text-2xs text-muted-foreground">
                          <summary className="flex min-h-11 cursor-pointer items-center">Estimate evidence</summary>
                          <div className="space-y-1 pb-2">
                            <p>{draft.estimate.reasoning}</p>
                            <p>{formatCurrency(draft.estimate.low_cents, currency)}–{formatCurrency(draft.estimate.high_cents, currency)} · {draft.estimate.confidence} confidence · as of {draft.estimate.as_of}</p>
                            {draft.estimate.sources.map((source) => (
                              <p key={source.url}><a className="underline" href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                  <label className="space-y-1 text-2xs text-muted-foreground">
                    Replacement / unit
                    <Input
                      aria-label={`Replacement value for ${item.name}`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={draft.amount}
                      disabled={!checked}
                      onChange={(event) => updateAmount(item, event.target.value)}
                      placeholder="Unknown"
                    />
                  </label>
                  <div className="text-2xs">
                    <p className="text-muted-foreground">Owned total</p>
                    <p className="mt-1 font-medium">
                      {cents == null || !Number.isFinite(cents) ? "Unknown" : formatCurrency(cents * item.quantity, currency)}
                    </p>
                    {draft.estimate && <Badge variant="outline" className="mt-2">{draft.estimate.source === "ai_web" ? "AI + web" : "AI"}</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 p-4 sm:p-5">
            <p className="text-2xs text-muted-foreground" role="status">
              {includedRows.length} of {pluralize(rows.length, "item")} included · {summary.valued} valued ·{" "}
              {summary.unknown} unknown
            </p>
            <Button className="h-11" disabled={!includedRows.length} onClick={() => setStep("export")}>
              Continue to export
              <ArrowRight />
            </Button>
          </div>
        </section>
      )}

      {step === "export" && preview && (
        <section className="surface p-4 sm:p-5" aria-label="Export">
          <h2 className="font-display text-xl">Check the list, then export</h2>
          <dl className="mt-3 divide-y divide-border/60 rounded-xl border border-border/60 text-xs">
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted-foreground">Items in the list</dt>
              <dd className="text-right tabular-nums">
                {includedRows.length} ({pluralize(summary.units, "owned unit")})
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted-foreground">With a replacement value</dt>
              <dd className="text-right tabular-nums">{summary.valued}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted-foreground">Value unknown</dt>
              <dd className="text-right tabular-nums">{summary.unknown}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted-foreground">
                Total in {currency}
                <span className="block text-2xs">Value per unit × owned quantity</span>
              </dt>
              <dd className="text-right font-medium tabular-nums">
                {summary.valued > 0 ? formatCurrency(summary.totalCents, currency) : "Unknown"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            The list shows the value per unit and the total for the owned quantity in separate
            columns. {summary.unknown > 0
              ? `${pluralize(summary.unknown, "item")} with no value ${summary.unknown === 1 ? "is" : "are"} listed as unknown and ${summary.unknown === 1 ? "is" : "are"} not in the total.`
              : "Every included item has a value."}
          </p>
          {summary.invalid > 0 && (
            <p className="mt-2 text-2xs text-destructive">
              {pluralize(summary.invalid, "value")} cannot be read. Go back to the review and correct{" "}
              {summary.invalid === 1 ? "it" : "them"}.
            </p>
          )}
          <p className="mt-3 text-2xs text-muted-foreground">
            <ShieldCheck className="mr-1 inline size-3.5" /> Export only. No item value or purchase history is changed.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" className="h-11" onClick={() => setStep("review")}>
              <ArrowLeft />
              Back to review
            </Button>
            {canWrite ? (
              <Button className="h-11" disabled={listBusy || !includedRows.length} onClick={submitList}>
                {listBusy ? <Spinner /> : <Download />}
                Generate insurance list
              </Button>
            ) : (
              <p className="text-2xs text-muted-foreground">
                Viewers cannot generate insurance lists. Ask an owner for member access.
              </p>
            )}
          </div>
          {list?.status === "succeeded" && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/60 pt-4" role="status">
              <Badge variant="sage">Insurance list ready</Badge>
              {list.pdf_url && <Button className="h-11" asChild><a href={list.pdf_url}><Download />Download PDF</a></Button>}
              {list.csv_url && <Button variant="outline" className="h-11" asChild><a href={list.csv_url}><Download />Download CSV</a></Button>}
            </div>
          )}
          {list?.status === "failed" && <div className="mt-4"><FormError message={list.error || "Insurance list generation failed."} /></div>}
        </section>
      )}

      <section className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
        <p className="min-w-0 text-2xs leading-relaxed text-muted-foreground">
          Need receipts, photographs and documents instead? An evidence export holds the
          recorded facts of the whole household. It is not a valuation.
        </p>
        <Button variant="outline" className="h-11" onClick={() => setEvidenceOpen(true)}>
          <Paperclip />
          Export evidence
        </Button>
      </section>
      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ include_home: true }}
      />
    </PageLayout>
  );
}
