import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, FileText, ShieldCheck, Sparkles } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
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
import { formatCurrency } from "@/lib/utils";

type ScopeType = "household" | "property" | "room" | "container" | "items";
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
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  React.useEffect(() => {
    if (deepLinkedIds.length) loadPreview.mutate();
    // Load only the initial explicit selection; other scopes are deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const batchTerminal = batch
    ? ["completed", "partial", "cancelled"].includes(batch.status)
    : true;
  const batchQuery = useQuery({
    queryKey: ["insurance-batch", batch?.request_id],
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
    queryKey: ["insurance-list", list?.id],
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

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Insurance"
        title="Create insurance list"
        description="Review replacement values only for this dated export. Nothing is written back to your item records."
      />
      <section className="surface mb-5 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select aria-label="Insurance scope" value={scopeType} onChange={(event) => {
            setScopeType(event.target.value as ScopeType);
            setScopeId("");
          }}>
            <option value="household">Whole household</option>
            <option value="property">Property</option>
            <option value="room">Room</option>
            <option value="container">Container or place</option>
            {deepLinkedIds.length > 0 && <option value="items">Selected items</option>}
          </Select>
          {scopeType !== "household" && scopeType !== "items" && (
            <Select aria-label="Insurance scope detail" value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
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
          <Input aria-label="Reviewed on" type="date" value={reviewedOn} onChange={(event) => setReviewedOn(event.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[0.75rem] text-muted-foreground">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
            Include archived
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={includeWeb} onChange={(event) => {
              setIncludeWeb(event.target.checked);
              setBatch(null);
            }} />
            Use public comparisons where available
          </label>
          <Button disabled={loadPreview.isPending || (scopeType !== "household" && scopeType !== "items" && !scopeId)} onClick={() => loadPreview.mutate()}>
            {loadPreview.isPending ? <Spinner /> : <FileText />}
            Review inventory
          </Button>
        </div>
      </section>

      {error && <div className="mb-5"><FormError message={error} /></div>}

      {preview && (
        <section className="surface overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4 sm:p-5">
            <div>
              <h2 className="font-display text-xl">{preview.scope_label}</h2>
              <p className="mt-1 text-[0.75rem] text-muted-foreground">
                {rows.length} items · values per owned unit · blank means unknown
              </p>
              <p className="mt-1 text-[0.68rem] text-muted-foreground">
                AI estimates process up to 10 eligible items per batch.
              </p>
            </div>
            {canWrite && (
              <Button
                disabled={!eligibleIds.length || startBatch.isPending || batchRunning}
                onClick={() => startBatch.mutate(eligibleIds)}
              >
                {startBatch.isPending || batchRunning ? <Spinner /> : <Sparkles />}
                {batchRunning ? "Estimating…" : `Estimate ${eligibleIds.length || "eligible"} with AI`}
              </Button>
            )}
          </div>
          <div className="divide-y divide-border/60">
            {rows.map((item) => {
              const draft = drafts[item.item_id]!;
              const checked = included.has(item.item_id);
              const cents = draft.amount.trim() ? Math.round(Number(draft.amount) * 100) : null;
              return (
                <div key={item.item_id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_150px_130px] sm:items-start sm:p-5">
                  <div className="flex items-start gap-3">
                    <input
                      className="mt-1 size-4 shrink-0 accent-primary"
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
                    <div className="min-w-0">
                      <p className="font-medium">{item.name}</p>
                      <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
                        {[item.brand, item.model].filter(Boolean).join(" · ") || "No brand/model"} · {item.quantity} owned
                      </p>
                      {!item.ai_eligible && <p className="mt-1 text-[0.68rem] text-brass">{item.ai_ineligible_reason}</p>}
                      {batch?.items.find((entry) => entry.item_id === item.item_id)?.error && (
                        <p className="mt-1 text-[0.68rem] text-destructive">
                          {batch.items.find((entry) => entry.item_id === item.item_id)?.error}
                        </p>
                      )}
                      {draft.estimate && (
                        <details className="mt-2 text-[0.7rem] text-muted-foreground">
                          <summary className="cursor-pointer">Estimate evidence</summary>
                          <div className="mt-2 space-y-1">
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
                  <label className="space-y-1 text-[0.7rem] text-muted-foreground">
                    Replacement / unit
                    <Input
                      aria-label={`Replacement value for ${item.name}`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft.amount}
                      disabled={!checked}
                      onChange={(event) => updateAmount(item, event.target.value)}
                      placeholder="Unknown"
                    />
                  </label>
                  <div className="text-[0.75rem]">
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
            <p className="text-[0.72rem] text-muted-foreground">
              <ShieldCheck className="mr-1 inline size-3.5" /> Export only. No item value or purchase history is changed.
            </p>
            {canWrite && (
              <Button disabled={createList.isPending || (listQuery.isFetching && !list?.pdf_url)} onClick={submitList}>
                {createList.isPending || (list && list.status !== "succeeded" && list.status !== "failed") ? <Spinner /> : <Download />}
                Generate insurance list
              </Button>
            )}
          </div>
        </section>
      )}

      {list?.status === "succeeded" && (
        <section className="surface mt-5 flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Badge variant="sage">Insurance list ready</Badge>
          {list.pdf_url && <Button asChild><a href={list.pdf_url}><Download />Download PDF</a></Button>}
          {list.csv_url && <Button variant="outline" asChild><a href={list.csv_url}><Download />Download CSV</a></Button>}
        </section>
      )}
      {list?.status === "failed" && <div className="mt-5"><FormError message={list.error || "Insurance list generation failed."} /></div>}
      <p className="mt-5 text-[0.72rem] text-muted-foreground">
        Need receipts and photographs instead? Use the ordinary <Link className="underline" to="/">evidence export</Link>.
      </p>
    </div>
  );
}
