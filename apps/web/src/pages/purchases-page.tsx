import { useMutation } from "@tanstack/react-query";
import {
  Download,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Field, FormError } from "@/components/form-field";
import { ItemMultiSelect } from "@/components/item-multi-select";
import { PageHeader } from "@/components/page-header";
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
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import { CURRENCIES, DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import {
  useDocuments,
  useInvalidateInventory,
  usePurchases,
} from "@/lib/queries";
import type { Purchase, PurchaseFormInput } from "@/lib/types";
import { formatCurrency, formatDate, pluralize } from "@/lib/utils";

export function PurchasesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const invalidate = useInvalidateInventory();
  const [search, setSearch] = React.useState(searchParams.get("q") ?? "");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [currency, setCurrency] = React.useState(searchParams.get("currency") ?? "");
  const [dateFrom, setDateFrom] = React.useState(searchParams.get("date_from") ?? "");
  const [dateTo, setDateTo] = React.useState(searchParams.get("date_to") ?? "");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Purchase | null>(null);
  const [purchaseToDelete, setPurchaseToDelete] = React.useState<Purchase | null>(null);

  const purchasesQuery = usePurchases({
    q: debouncedSearch.trim() || undefined,
    currency: currency || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  });

  const remove = useMutation({
    mutationFn: (purchaseId: string) => api.delete<void>(`/purchases/${purchaseId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Purchase deleted; its items were kept");
      setPurchaseToDelete(null);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const updateParam = (key: string, value: string) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const purchases = purchasesQuery.data?.items ?? [];
  const hasFilters = Boolean(debouncedSearch.trim() || currency || dateFrom || dateTo);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Ownership"
        title="Purchases"
        description="What you paid, where it came from, and the receipt trail. One purchase can cover several items."
        actions={
          <>
            <Button variant="outline" asChild>
              <a href="/api/v1/exports/purchases.csv">
                <Download />
                Export
              </a>
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              Add purchase
            </Button>
          </>
        }
      />

      <div className="surface p-4 sm:p-5">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_150px_150px_150px]">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                updateParam("q", event.target.value);
              }}
              placeholder="Search merchant, order, notes or item…"
              aria-label="Search purchases"
              className="h-10 pl-10"
            />
          </div>
          <Select
            aria-label="Filter purchases by currency"
            value={currency}
            onChange={(event) => {
              setCurrency(event.target.value);
              updateParam("currency", event.target.value);
            }}
            className="h-10"
          >
            <option value="">All currencies</option>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            value={dateFrom}
            aria-label="Purchases from date"
            onChange={(event) => {
              setDateFrom(event.target.value);
              updateParam("date_from", event.target.value);
            }}
            className="h-10"
          />
          <Input
            type="date"
            value={dateTo}
            aria-label="Purchases to date"
            onChange={(event) => {
              setDateTo(event.target.value);
              updateParam("date_to", event.target.value);
            }}
            className="h-10"
          />
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3">
          <p className="text-[0.72rem] text-muted-foreground">
            {purchasesQuery.data
              ? `${pluralize(purchasesQuery.data.total, "purchase")}${hasFilters ? " matching" : ""}`
              : "Loading…"}
          </p>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setCurrency("");
                setDateFrom("");
                setDateTo("");
                setSearchParams({}, { replace: true });
              }}
              className="text-[0.72rem] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="mt-7">
        {purchasesQuery.isPending ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-44 rounded-2xl" />
            ))}
          </div>
        ) : purchasesQuery.isError ? (
          <ErrorState
            title="Purchases are out of reach"
            message="We couldn't load your purchase records just now."
            onRetry={() => void purchasesQuery.refetch()}
          />
        ) : purchases.length === 0 ? (
          <EmptyState
            title={hasFilters ? "No purchases match." : "Every object has a story of how it arrived."}
            description={
              hasFilters
                ? "Try a broader search or clear the filters."
                : "Record the date, amount, merchant and receipt. Link one purchase to several items when they were bought together."
            }
            actionLabel={hasFilters ? undefined : "Add your first purchase"}
            onAction={hasFilters ? undefined : openCreate}
            secondary={
              hasFilters ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch("");
                    setCurrency("");
                    setDateFrom("");
                    setDateTo("");
                    setSearchParams({}, { replace: true });
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="stagger grid gap-3 lg:grid-cols-2">
            {purchases.map((purchase) => (
              <article key={purchase.id} className="surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-display text-[1.3rem] tracking-[-0.02em]">
                        {purchase.merchant || purchase.vendor || "Unnamed purchase"}
                      </h2>
                      {purchase.is_shared && (
                        <Badge variant="brass">
                          <Users className="size-3" />
                          Shared · {purchase.item_count}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[0.72rem] text-muted-foreground">
                      {purchase.purchase_date
                        ? formatDate(purchase.purchase_date)
                        : "No purchase date"}
                      {purchase.order_number ? ` · ${purchase.order_number}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {purchase.price_cents != null ? (
                      <p className="font-display text-[1.5rem] leading-none tracking-[-0.03em] tabular-nums">
                        {formatCurrency(purchase.price_cents, purchase.currency)}
                      </p>
                    ) : (
                      <p className="text-[0.75rem] text-muted-foreground">No amount</p>
                    )}
                    <div className="mt-2 flex justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(purchase);
                          setDialogOpen(true);
                        }}
                        className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        aria-label={`Edit purchase from ${purchase.merchant ?? "unknown merchant"}`}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPurchaseToDelete(purchase)}
                        className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Delete purchase from ${purchase.merchant ?? "unknown merchant"}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {purchase.items.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {purchase.items.map((item) => (
                      <Link key={item.id} to={`/items/${item.id}`}>
                        <Badge variant="secondary" className="hover:bg-secondary/70">
                          <Package className="size-3" />
                          {item.name}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/60 pt-3 text-[0.72rem]">
                  {purchase.receipt ? (
                    <Link
                      to={`/documents/${purchase.receipt.id}`}
                      className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <ReceiptText className="size-3.5" />
                      {purchase.receipt.title}
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <ReceiptText className="size-3.5" />
                      No receipt attached
                    </span>
                  )}
                  {purchase.notes && (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {purchase.notes}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <PurchaseDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        purchase={editing}
      />

      <ConfirmDialog
        open={Boolean(purchaseToDelete)}
        onOpenChange={(open) => {
          if (!open) setPurchaseToDelete(null);
        }}
        title="Delete this purchase?"
        description="The purchase record will be removed. Its items stay in your inventory and their purchase details become empty."
        confirmLabel="Delete purchase"
        onConfirm={async () => {
          if (!purchaseToDelete) return;
          await remove.mutateAsync(purchaseToDelete.id);
        }}
      />
    </div>
  );
}

function PurchaseDialog({
  open,
  onOpenChange,
  purchase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: Purchase | null;
}) {
  const invalidate = useInvalidateInventory();
  const documentsQuery = useDocuments({}, 100);
  const [merchant, setMerchant] = React.useState("");
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [currency, setCurrency] = React.useState("USD");
  const [orderNumber, setOrderNumber] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [receiptDocumentId, setReceiptDocumentId] = React.useState("");
  const [itemIds, setItemIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setMerchant(purchase?.merchant ?? purchase?.vendor ?? "");
    setPurchaseDate(purchase?.purchase_date ?? "");
    setPrice(
      purchase?.price_cents != null ? (purchase.price_cents / 100).toFixed(2) : "",
    );
    setCurrency(purchase?.currency ?? "USD");
    setOrderNumber(purchase?.order_number ?? "");
    setNotes(purchase?.notes ?? "");
    setReceiptDocumentId(purchase?.receipt_document_id ?? "");
    setItemIds(purchase?.items.map((item) => item.id) ?? []);
  }, [open, purchase]);

  const localPriceCents = price.trim() ? Math.round(Number(price) * 100) : null;
  const priceInvalid =
    price.trim().length > 0 &&
    (localPriceCents === null || !Number.isFinite(localPriceCents) || localPriceCents < 0);

  const save = useMutation({
    mutationFn: () => {
      const payload: PurchaseFormInput = {
        merchant: merchant.trim() || null,
        purchase_date: purchaseDate || null,
        price_cents: localPriceCents,
        currency,
        order_number: orderNumber.trim() || null,
        notes: notes.trim() || null,
        receipt_document_id: receiptDocumentId || null,
        item_ids: itemIds,
      };
      return purchase
        ? api.patch<{ purchase: Purchase }>(`/purchases/${purchase.id}`, payload)
        : api.post<{ purchase: Purchase }>("/purchases", payload);
    },
    onSuccess: () => {
      invalidate();
      toast.success(purchase ? "Purchase updated" : "Purchase added");
      onOpenChange(false);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{purchase ? "Edit purchase" : "Add a purchase"}</DialogTitle>
          <DialogDescription>
            One record can be shared by several items bought together. Nothing is
            duplicated per item.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (itemIds.length > 0 && !priceInvalid) save.mutate();
          }}
        >
          {save.error && <FormError message={getApiErrorMessage(save.error)} />}
          {itemIds.length === 0 && (
            <FormError message="Choose at least one item for this purchase." />
          )}
          {priceInvalid && <FormError message="Enter a valid price, such as 129.00." />}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Merchant" htmlFor="purchase-merchant" optional>
              <Input
                id="purchase-merchant"
                maxLength={160}
                value={merchant}
                onChange={(event) => setMerchant(event.target.value)}
                placeholder="Where it came from"
              />
            </Field>
            <Field label="Purchase date" htmlFor="purchase-date" optional>
              <Input
                id="purchase-date"
                type="date"
                value={purchaseDate}
                onChange={(event) => setPurchaseDate(event.target.value)}
              />
            </Field>
            <Field label="Price" htmlFor="purchase-price" optional>
              <Input
                id="purchase-price"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Currency" htmlFor="purchase-currency">
              <Select
                id="purchase-currency"
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
            <Field label="Order number" htmlFor="purchase-order" optional>
              <Input
                id="purchase-order"
                maxLength={120}
                value={orderNumber}
                onChange={(event) => setOrderNumber(event.target.value)}
                placeholder="Order or receipt reference"
              />
            </Field>
            <Field label="Receipt document" htmlFor="purchase-receipt" optional>
              <Select
                id="purchase-receipt"
                value={receiptDocumentId}
                onChange={(event) => setReceiptDocumentId(event.target.value)}
              >
                <option value="">No receipt linked</option>
                {(documentsQuery.data?.items ?? []).map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title} · {DOCUMENT_TYPE_LABELS[document.document_type]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <ItemMultiSelect
            selected={itemIds}
            onChange={setItemIds}
            label="Items in this purchase"
            hint="Select every item covered by this purchase."
            disabled={save.isPending}
          />

          <Field label="Notes" htmlFor="purchase-notes" optional>
            <Textarea
              id="purchase-notes"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Delivery notes, return window, who paid, anything worth remembering."
            />
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={itemIds.length === 0 || priceInvalid || save.isPending}
            >
              {save.isPending && <Spinner />}
              {purchase ? "Save changes" : "Add purchase"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
