import { useMutation } from "@tanstack/react-query";
import {
  ExternalLink,
  Info,
  Sparkles,
  Wallet,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { Spinner } from "@/components/ui/spinner";
import { CURRENCIES } from "@/lib/labels";
import { api, getApiErrorMessage } from "@/lib/api";
import { useDefaultCurrency, useInvalidateInventory } from "@/lib/queries";
import type {
  ItemDetail,
  ItemDetailResponse,
  ItemValueEstimate,
  ItemValuationPreview,
  ValuationConfidence,
  ValuationPurpose,
} from "@/lib/types";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

const PURPOSE_COPY: Record<
  ValuationPurpose,
  { label: string; description: string }
> = {
  resale: {
    label: "Resale value",
    description:
      "A realistic used-market amount a buyer might pay for this item now. Asking/listed comparisons are useful, but they are not confirmed sold prices.",
  },
  replacement: {
    label: "Replacement value",
    description:
      "What it could cost to buy a comparable replacement today. This is different from the used resale amount; the two purposes are never mixed silently.",
  },
};

function sourceLabel(source: ItemValueEstimate["source"]): string {
  if (source === "ai_web") return "AI estimate with web search snippets";
  if (source === "ai") return "Rough AI estimate without verified comparisons";
  return "Manual household value";
}

function confidenceLabel(confidence: ValuationConfidence | null): string {
  if (!confidence) return "No AI confidence";
  return `${confidence.charAt(0).toUpperCase()}${confidence.slice(1)} confidence`;
}

function isCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

function initialCurrency(item: ItemDetail, defaultCurrency: string) {
  if (item.current_value_cents != null && item.current_value_currency) {
    return item.current_value_currency;
  }
  return item.purchase?.currency || defaultCurrency;
}

export function ItemValuationDialog({
  open,
  onOpenChange,
  item,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ItemDetail;
  onApplied?: (item: ItemDetail) => void;
}) {
  const invalidateInventory = useInvalidateInventory();
  const defaultCurrency = useDefaultCurrency();
  const [purpose, setPurpose] = React.useState<ValuationPurpose>("resale");
  const [currency, setCurrency] = React.useState(
    initialCurrency(item, defaultCurrency),
  );
  const [includeWeb, setIncludeWeb] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [preview, setPreview] = React.useState<ItemValuationPreview | null>(null);
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPurpose("resale");
    setCurrency(initialCurrency(item, defaultCurrency));
    setIncludeWeb(false);
    setAmount("");
    setPreview(null);
    setEstimateError(null);
    setApplyError(null);
  }, [
    open,
    item.id,
    item.current_value_cents,
    item.current_value_currency,
    item.purchase?.currency,
    defaultCurrency,
  ]);

  const amountCents = amount.trim() ? Math.round(Number(amount) * 100) : null;
  const amountInvalid =
    amountCents == null ||
    !Number.isFinite(amountCents) ||
    amountCents < 0 ||
    amountCents > 10 ** 12;
  const currencyValid = isCurrency(currency);

  const clearPreview = () => {
    setPreview(null);
    setEstimateError(null);
    setApplyError(null);
  };

  const estimate = useMutation({
    mutationFn: () =>
      api.post<ItemValuationPreview>(
        `/items/${item.id}/valuation/estimate`,
        { purpose, currency, include_web: includeWeb },
      ),
    onSuccess: (result) => {
      setPreview(result);
      setAmount((result.suggested_cents / 100).toFixed(2));
      setCurrency(result.currency);
      setEstimateError(null);
      setApplyError(null);
    },
    onError: (error) => {
      setPreview(null);
      setEstimateError(getApiErrorMessage(error));
    },
  });

  const apply = useMutation({
    mutationFn: () => {
      if (!item.valuation_fingerprint) {
        throw new Error("Reload this item before applying a value.");
      }
      return api.post<ItemDetailResponse>(`/items/${item.id}/valuation/apply`, {
        estimate_id: preview?.estimate_id ?? null,
        purpose,
        amount_cents: amountCents,
        currency,
        expected_fingerprint: item.valuation_fingerprint,
      });
    },
    onSuccess: (result) => {
      invalidateInventory();
      toast.success("Current value applied and recorded in history");
      onApplied?.(result.item);
      onOpenChange(false);
    },
    onError: (error) => setApplyError(getApiErrorMessage(error)),
  });

  const webUnavailable = Boolean(preview && !preview.web_used && preview.web_reason);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="size-4 text-brass" />
            Estimate value
          </DialogTitle>
          <DialogDescription>
            Review a per-unit estimate before saving. Nothing is applied until you
            explicitly save, and cancelling changes nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-2xs font-medium text-foreground/85">
              What is this value for?
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(PURPOSE_COPY) as ValuationPurpose[]).map((value) => {
                const copy = PURPOSE_COPY[value];
                return (
                  <label
                    key={value}
                    className={cn(
                      "cursor-pointer rounded-xl border px-3.5 py-3 text-2xs leading-relaxed transition-colors",
                      purpose === value
                        ? "border-brass/40 bg-brass-soft/35"
                        : "border-border/60 bg-background/30 hover:bg-secondary/30",
                    )}
                  >
                    <input
                      type="radio"
                      name="valuation-purpose"
                      className="sr-only"
                      value={value}
                      checked={purpose === value}
                      onChange={() => {
                        setPurpose(value);
                        setAmount("");
                        clearPreview();
                      }}
                    />
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      {copy.label}
                      {purpose === value && <Badge variant="brass">Selected</Badge>}
                    </span>
                    <span className="mt-1 block text-muted-foreground">
                      {copy.description}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-2xs leading-relaxed text-muted-foreground">
            {item.current_value_cents == null ? (
              "No current value is recorded. Missing is not zero."
            ) : item.current_value_basis === "legacy_record_total" ? (
              <>
                Existing legacy record total:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(item.current_value_cents, item.current_value_currency)}
                </span>
                . It is reported once and is not multiplied by quantity. Applying a
                per-unit estimate converts it only after your explicit review.
              </>
            ) : (
              <>
                Existing per-unit value:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(item.current_value_cents, item.current_value_currency)}
                </span>
                . Applying a new value replaces it and records the change in history.
              </>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Currency" htmlFor="valuation-currency">
              <Select
                id="valuation-currency"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value);
                  setAmount("");
                  clearPreview();
                }}
              >
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <label className="flex items-start gap-2 rounded-xl border border-border/60 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 accent-primary"
                  checked={includeWeb}
                  onChange={(event) => {
                    setIncludeWeb(event.target.checked);
                    clearPreview();
                  }}
                />
                <span>
                  Try online comparisons (Brave)
                  <span className="mt-0.5 block text-2xs">
                    Sends a generic item name/brand/model/condition query only. No
                    location, borrower, serial, receipt or account data.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => estimate.mutate()}
              disabled={estimate.isPending || !currencyValid}
            >
              {estimate.isPending ? <Spinner /> : <Sparkles />}
              Get AI estimate
            </Button>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Uses your existing Assistant/text default provider and consent. Manual
              entry below works without AI.
            </p>
          </div>
          {estimateError && (
            <div className="rounded-xl border border-brass/25 bg-brass-soft/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground/85">AI estimate unavailable</p>
              <p className="mt-1">{estimateError}</p>
              <p className="mt-1">
                No automatic value was made. Enter the amount you want to save manually.
              </p>
            </div>
          )}

          {preview && (
            <section
              data-testid="valuation-preview"
              className="space-y-3 rounded-xl border border-sage/25 bg-sage-soft/20 px-3.5 py-3 text-2xs leading-relaxed"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-foreground">
                  {preview.purpose === "resale" ? "Resale" : "Replacement"} estimate
                </p>
                <Badge variant="sage">{sourceLabel(preview.source)}</Badge>
                <Badge variant="outline">{confidenceLabel(preview.confidence)}</Badge>
                {preview.web_used && <Badge variant="brass">Web snippets used</Badge>}
              </div>
              <div>
                <p className="font-display text-[1.6rem] leading-none tracking-[-0.02em] tabular-nums">
                  {formatCurrency(preview.suggested_cents, preview.currency)}
                  <span className="ml-1 font-sans text-2xs font-normal text-muted-foreground">
                    per unit suggested
                  </span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  Range {formatCurrency(preview.low_cents, preview.currency)} –{" "}
                  {formatCurrency(preview.high_cents, preview.currency)} per unit · as
                  of {formatDate(preview.as_of)}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {preview.owned_quantity} owned{" "}
                  {preview.owned_quantity === 1 ? "unit" : "units"} × suggested ={" "}
                  <span className="font-medium text-foreground/80">
                    {formatCurrency(
                      preview.suggested_total_cents,
                      preview.currency,
                    )}{" "}
                    owned total
                  </span>
                  {preview.owned_quantity > 0 && (
                    <>
                      {" "}
                      · range{" "}
                      {formatCurrency(preview.low_total_cents, preview.currency)} –{" "}
                      {formatCurrency(preview.high_total_cents, preview.currency)} total
                    </>
                  )}
                  . Loaned owned units remain included; borrowed items are not owned.
                </p>
              </div>
              <p>{preview.reasoning}</p>
              {preview.assumptions.length > 0 && (
                <p className="text-muted-foreground">
                  Assumptions: {preview.assumptions.join(" · ")}
                </p>
              )}
              {webUnavailable && (
                <p className="rounded-lg border border-brass/20 bg-background/40 px-3 py-2 text-muted-foreground">
                  {preview.web_reason}
                </p>
              )}
              {preview.sources.length > 0 && (
                <div className="space-y-1.5">
                  <p className="font-medium text-foreground/85">Supporting links</p>
                  {preview.sources.map((sourceEntry) => (
                    <a
                      key={sourceEntry.url}
                      href={sourceEntry.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded-lg border border-border/50 bg-background/40 px-2.5 py-2 text-2xs text-foreground/80 underline-offset-4 hover:underline"
                    >
                      <span className="inline-flex max-w-full items-center gap-1 font-medium">
                        <span className="truncate">{sourceEntry.title}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </span>
                      <span className="mt-0.5 block text-muted-foreground">
                        {sourceEntry.price_text
                          ? `${sourceEntry.price_text} · asking/listed price from search snippet`
                          : "No price extracted from this search snippet"}
                        {sourceEntry.price_cents != null &&
                          sourceEntry.currency &&
                          ` · ${formatCurrency(
                            sourceEntry.price_cents,
                            sourceEntry.currency,
                          )}${
                            sourceEntry.currency_inferred
                              ? " (currency inferred from symbol)"
                              : ""
                          }`}
                        {" · "}retrieved {formatDate(sourceEntry.retrieved_on)}
                      </span>
                    </a>
                  ))}
                  <p className="text-2xs text-muted-foreground">
                    Links are retrieved search results. Asking/listed prices are not
                    confirmed sold prices; open the original listing before relying on
                    it.
                  </p>
                </div>
              )}
              <p className="flex gap-1.5 text-2xs text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" />
                {preview.disclaimer}
              </p>
            </section>
          )}

          <section className="space-y-3 rounded-xl border border-border/60 bg-background/35 px-3.5 py-3">
            <div>
              <p className="text-2xs font-medium text-foreground/85">
                Value to save
              </p>
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                Edit the per-unit amount if needed. You can save manually without
                requesting an AI estimate.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_130px]">
              <Field label="Per-unit value" htmlFor="valuation-amount">
                <Input
                  id="valuation-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Currency" htmlFor="valuation-save-currency">
                <Select
                  id="valuation-save-currency"
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                    if (preview) setAmount("");
                    clearPreview();
                  }}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {amountCents != null && !amountInvalid && (
              <p
                data-testid="valuation-save-total"
                className="text-2xs text-muted-foreground"
              >
                {item.quantity} owned {item.quantity === 1 ? "unit" : "units"} ×{" "}
                {formatCurrency(amountCents, currency)} ={" "}
                <span className="font-medium text-foreground/80">
                  {formatCurrency(amountCents * item.quantity, currency)} owned total
                </span>
                . Loaned owned units remain included; borrowed items are not owned.
              </p>
            )}
            {amountInvalid && amount.trim() && (
              <FormError message="Enter a valid non-negative per-unit amount." />
            )}
            {applyError && <FormError message={applyError} />}
          </section>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => apply.mutate()}
            disabled={
              apply.isPending ||
              amountInvalid ||
              !currencyValid ||
              !item.valuation_fingerprint
            }
          >
            {apply.isPending ? <Spinner /> : <Wallet />}
            Apply value
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
