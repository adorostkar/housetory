import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  Download,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Field, FormError } from "@/components/form-field";
import { InvoiceImportButtons } from "@/components/invoice-import-buttons";
import { ItemMultiSelect } from "@/components/item-multi-select";
import { PurchaseTotals } from "@/components/purchase-totals";
import { ReceiptPicker } from "@/components/receipt-picker";
import { PageLayout } from "@/components/page-layout";
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
import { useCanWrite, useDefaultCurrency } from "@/lib/queries";
import { CURRENCIES } from "@/lib/labels";
import {
  useInvalidateInventory,
  usePurchases,
} from "@/lib/queries";
import type { Purchase, PurchaseFormInput } from "@/lib/types";
import { cn, formatCurrency, formatDate, pluralize } from "@/lib/utils";

export function PurchasesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const invalidate = useInvalidateInventory();
  const [search, setSearch] = React.useState(searchParams.get("q") ?? "");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [currency, setCurrency] = React.useState(searchParams.get("currency") ?? "");
  const [dateFrom, setDateFrom] = React.useState(searchParams.get("date_from") ?? "");
  const [dateTo, setDateTo] = React.useState(searchParams.get("date_to") ?? "");
  const canWrite = useCanWrite();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Purchase | null>(null);
  const [purchaseToDelete, setPurchaseToDelete] = React.useState<Purchase | null>(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());

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

  // The search stays in view, so it is not counted as a filter.
  const filterChips = [
    currency
      ? {
          key: "currency",
          label: currency,
          remove: () => {
            setCurrency("");
            updateParam("currency", "");
          },
        }
      : null,
    dateFrom
      ? {
          key: "date_from",
          label: `From ${formatDate(dateFrom)}`,
          remove: () => {
            setDateFrom("");
            updateParam("date_from", "");
          },
        }
      : null,
    dateTo
      ? {
          key: "date_to",
          label: `To ${formatDate(dateTo)}`,
          remove: () => {
            setDateTo("");
            updateParam("date_to", "");
          },
        }
      : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);

  const clearFilters = () => {
    setSearch("");
    setCurrency("");
    setDateFrom("");
    setDateTo("");
    setSearchParams({}, { replace: true });
  };

  const toggleExpanded = (purchaseId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(purchaseId)) next.delete(purchaseId);
      else next.add(purchaseId);
      return next;
    });
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <PageLayout
      header={{
        title: "Purchases",
        titleAddon: (
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">
              {purchasesQuery.data
                ? `${pluralize(purchasesQuery.data.total, "purchase")}${hasFilters ? " matching" : ""}`
                : "Loading…"}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              {canWrite && (
                <Button onClick={openCreate}>
                  <Plus />
                  Add purchase
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="More purchase actions"
                aria-expanded={moreActionsOpen}
                aria-controls="purchase-more-actions"
                onClick={() => setMoreActionsOpen((open) => !open)}
              >
                <MoreHorizontal />
              </Button>
            </div>
          </div>
        ),
      }}
    >
      {moreActionsOpen && (
        <div id="purchase-more-actions" className="mb-4 flex flex-wrap items-center gap-2">
          {canWrite && <InvoiceImportButtons />}
          <Button variant="outline" asChild>
            <a href="/api/v1/exports/purchases.csv">
              <Download />
              Export
            </a>
          </Button>
        </div>
      )}
      <PurchaseTotals />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              updateParam("q", event.target.value);
            }}
            placeholder="Search purchases"
            aria-label="Search purchases"
            className="pl-10"
          />
        </div>
        <button
          type="button"
          className="flex h-11 shrink-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={filtersOpen}
          aria-controls="purchase-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>Filters</span>
          {filterChips.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
              <span className="sr-only">Active filters: </span>
              {filterChips.length}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              filtersOpen && "rotate-180",
            )}
          />
        </button>
      </div>

      {(filtersOpen || filterChips.length > 0) && (
        <div className="surface mb-2 p-3.5">
          {filtersOpen && (
            <div
              id="purchase-filters"
              className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] items-end gap-2"
            >
              <Select
                aria-label="Filter purchases by currency"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value);
                  updateParam("currency", event.target.value);
                }}
                className="rounded-lg text-sm"
              >
                <option value="">All currencies</option>
                {CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
              <label className="block min-w-0 text-2xs text-muted-foreground">
                From
                <Input
                  type="date"
                  value={dateFrom}
                  aria-label="Purchases from date"
                  onChange={(event) => {
                    setDateFrom(event.target.value);
                    updateParam("date_from", event.target.value);
                  }}
                  className="mt-0.5 rounded-lg text-sm"
                />
              </label>
              <label className="block min-w-0 text-2xs text-muted-foreground">
                To
                <Input
                  type="date"
                  value={dateTo}
                  aria-label="Purchases to date"
                  onChange={(event) => {
                    setDateTo(event.target.value);
                    updateParam("date_to", event.target.value);
                  }}
                  className="mt-0.5 rounded-lg text-sm"
                />
              </label>
            </div>
          )}
          {filterChips.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5",
                filtersOpen && "mt-3 border-t border-border/60 pt-3",
              )}
            >
              {filterChips.map((chip) => (
                <Badge key={chip.key} variant="secondary" className="max-w-full gap-1 py-0 pl-2.5 pr-0 text-2xs">
                  <span className="min-w-0 max-w-56 truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.remove}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:size-7 coarse:!size-11"
                    aria-label={`Remove ${chip.label}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              <button
                type="button"
                onClick={clearFilters}
                className="ml-1 min-h-11 text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-0 coarse:!min-h-11"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        {purchasesQuery.isPending ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 rounded-2xl" />
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
            actionLabel={hasFilters || !canWrite ? undefined : "Add your first purchase"}
            onAction={hasFilters || !canWrite ? undefined : openCreate}
            secondary={
              hasFilters ? (
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid items-start gap-2 lg:grid-cols-2">
            {purchases.map((purchase) => (
              <PurchaseRow
                key={purchase.id}
                purchase={purchase}
                open={expanded.has(purchase.id)}
                onToggle={() => toggleExpanded(purchase.id)}
                onEdit={
                  canWrite
                    ? () => {
                        setEditing(purchase);
                        setDialogOpen(true);
                      }
                    : undefined
                }
                onDelete={canWrite ? () => setPurchaseToDelete(purchase) : undefined}
              />
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
    </PageLayout>
  );
}

/**
 * One purchase as a short row: merchant, date, total and item count.
 * Opening it shows the items, the reviewed allocations and the receipt.
 */
function PurchaseRow({
  purchase,
  open,
  onToggle,
  onEdit,
  onDelete,
}: {
  purchase: Purchase;
  open: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const detailsId = React.useId();
  const merchant = purchase.merchant || purchase.vendor || "Unnamed purchase";
  return (
    <article className="surface" data-testid="purchase-row">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left transition-colors hover:bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground/90">
              {merchant}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs font-normal text-muted-foreground">
              <span>
                {purchase.purchase_date ? formatDate(purchase.purchase_date) : "No purchase date"}
                {" · "}
                {pluralize(purchase.item_count, "item")}
              </span>
              {purchase.is_shared && (
                <span className="inline-flex items-center gap-1 rounded-full border border-brass/15 bg-brass-soft px-2 font-medium text-brass">
                  <Users className="size-3" aria-hidden="true" />
                  Shared · {purchase.item_count}
                </span>
              )}
            </span>
          </span>
          <span className="shrink-0 text-right text-sm font-medium tabular-nums text-foreground/85">
            {purchase.price_cents != null ? (
              formatCurrency(purchase.price_cents, purchase.currency)
            ) : (
              <span className="text-2xs font-normal text-muted-foreground">No amount</span>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </h2>

      {open && (
        <div id={detailsId} className="space-y-3 border-t border-border/60 px-3.5 pb-3.5 pt-3">
          {purchase.order_number && (
            <p className="text-2xs text-muted-foreground">Order {purchase.order_number}</p>
          )}

          {purchase.items.length > 0 && (
            <div>
              <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Items in this purchase
              </p>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                {purchase.items.map((item) => (
                  <Link
                    key={item.id}
                    to={`/items/${item.id}`}
                    className="group inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium leading-snug text-foreground/85 transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 coarse:min-h-11"
                  >
                    <Package className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground/70" />
                    <span className="min-w-0 break-words text-left">{item.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {purchase.allocations.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-secondary/20 p-3 text-2xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground/80">Reviewed item allocations</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(purchase.allocated_total_cents, purchase.currency)} allocated
                </span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {purchase.allocations.map((allocation) => (
                  <li
                    key={allocation.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground"
                  >
                    <span className="min-w-0 break-words">
                      {allocation.item.name} ×{allocation.quantity}
                      <span className="ml-1 text-muted-foreground">{allocation.description}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {allocation.allocated_cents == null
                        ? "amount unknown"
                        : formatCurrency(allocation.allocated_cents, allocation.currency)}
                    </span>
                  </li>
                ))}
              </ul>
              {purchase.unallocated_cents != null && purchase.unallocated_cents !== 0 && (
                <p className="mt-2 border-t border-border/60 pt-2 text-2xs text-muted-foreground">
                  {purchase.unallocated_cents > 0
                    ? `${formatCurrency(
                        purchase.unallocated_cents,
                        purchase.currency,
                      )} of the purchase total is not allocated to product lines.`
                    : `Product allocations exceed the purchase total by ${formatCurrency(
                        Math.abs(purchase.unallocated_cents),
                        purchase.currency,
                      )} because of recorded discounts or charges.`}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
            {purchase.receipt ? (
              <Link
                to={`/documents/${purchase.receipt.id}`}
                className="inline-flex min-h-9 items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline coarse:min-h-11"
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
            {(onEdit || onDelete) && (
              <span className="ml-auto flex items-center gap-1">
                {onEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onEdit}
                    aria-label={`Edit purchase from ${purchase.merchant ?? "unknown merchant"}`}
                  >
                    <Pencil />
                    Edit
                  </Button>
                )}
                {onDelete && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onDelete}
                    aria-label={`Delete purchase from ${purchase.merchant ?? "unknown merchant"}`}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                )}
              </span>
            )}
          </div>
          {purchase.notes && (
            <p className="whitespace-pre-line text-2xs leading-relaxed text-muted-foreground">
              {purchase.notes}
            </p>
          )}
        </div>
      )}
    </article>
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
  const defaultCurrency = useDefaultCurrency();
  const [merchant, setMerchant] = React.useState("");
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [currencyTouched, setCurrencyTouched] = React.useState(false);
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
    setCurrency(purchase?.currency ?? defaultCurrency);
    setCurrencyTouched(false);
    setOrderNumber(purchase?.order_number ?? "");
    setNotes(purchase?.notes ?? "");
    setReceiptDocumentId(purchase?.receipt_document_id ?? "");
    setItemIds(purchase?.items.map((item) => item.id) ?? []);
  }, [open, purchase]);

  React.useEffect(() => {
    if (open && !purchase && !currencyTouched) setCurrency(defaultCurrency);
  }, [currencyTouched, defaultCurrency, open, purchase]);

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
            <Field label="Purchase total" htmlFor="purchase-price" optional>
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
                onChange={(event) => {
                  setCurrency(event.target.value);
                  setCurrencyTouched(true);
                }}
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
            <ReceiptPicker
              id="purchase-receipt"
              value={receiptDocumentId}
              onChange={setReceiptDocumentId}
            />
          </div>

          <p className="text-2xs leading-relaxed text-muted-foreground">
            Enter the total paid for all selected items. If one item is a multi-unit
            pack, its item page shows the effective per-unit cost derived from this
            package total and its quantity.
          </p>

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
