import {
  ChevronDown,
  DoorOpen,
  Download,
  Eye,
  EyeOff,
  FileText,
  Package,
  ReceiptText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useId, useState } from "react";
import { toast } from "sonner";

import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOverview } from "@/lib/queries";
import type { FinancialOverview } from "@/lib/types";
import { cn, formatCurrency, pluralize } from "@/lib/utils";

/** An open or closed summary box, as the user left it on this device. */
export function useRememberedOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "open";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      if (next) localStorage.setItem(key, "open");
      else localStorage.removeItem(key);
    } catch {
      // The box still opens and closes for this visit.
    }
  };
  return [open, toggle];
}

const VALUES_HIDDEN_KEY = "housetory.overview.values-hidden";
const MASK = "••••••";

/**
 * Inventory totals and the purchase report. It is one short line until it is
 * opened, so it does not push the purchases down.
 */
export function PurchaseTotals({ className }: { className?: string }) {
  const overview = useOverview(true);
  const detailsId = useId();
  const [open, toggleOpen] = useRememberedOpen("housetory.totals");
  const [valuesHidden, setValuesHidden] = useState(() => {
    try {
      return localStorage.getItem(VALUES_HIDDEN_KEY) === "true";
    } catch {
      return true;
    }
  });
  const toggleValues = () => {
    const hidden = !valuesHidden;
    setValuesHidden(hidden);
    try {
      localStorage.setItem(VALUES_HIDDEN_KEY, String(hidden));
    } catch {
      toast.error("Your browser could not save this privacy preference. It applies until you leave.");
    }
  };

  const data = overview.data;
  if (!data || data.item_count === 0) return null;

  const warranties = data.warranties;
  const activeWarranties = warranties.active_count + warranties.expiring_count;
  const hasWarranties =
    activeWarranties + warranties.expired_count + warranties.unknown_count > 0;
  const values = data.value_by_currency;

  return (
    <section
      aria-label="Totals"
      data-testid="purchase-totals"
      className={cn("surface mb-5 px-4 py-2", className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={toggleOpen}
          className="-ml-1 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
          <span className="min-w-0 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Totals</span>
            {" · "}
            {pluralize(data.item_count, "item")} · {pluralize(data.room_count, "room")}
            {values.length > 0 && (
              <>
                {" · "}
                {valuesHidden
                  ? MASK
                  : values
                      .map((entry) => formatCurrency(entry.total_cents, entry.currency, { compact: true }))
                      .join(" + ")}
              </>
            )}
            {activeWarranties > 0 && <> · {pluralize(activeWarranties, "active warranty", "active warranties")}</>}
          </span>
        </button>
        {values.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={valuesHidden ? "Show purchase values" : "Hide purchase values"}
            aria-pressed={valuesHidden}
            onClick={toggleValues}
          >
            {valuesHidden ? <EyeOff /> : <Eye />}
          </Button>
        )}
      </div>

      {open && (
        <div id={detailsId} className="space-y-4 border-t border-border/60 pb-2 pt-4">
          <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
            <StatCard
              label="Items"
              value={data.item_count}
              detail={`${data.total_quantity} total pieces`}
              icon={Package}
              to="/items"
              accent
            />
            <StatCard
              label="Rooms"
              value={data.room_count}
              detail={pluralize(data.location_count, "storage place")}
              icon={DoorOpen}
              to="/rooms"
            />
            {values.length > 0 && (
              <StatCard
                label="Purchase value"
                value={
                  <span className="block space-y-2 break-words text-[1.65rem] sm:text-[2rem]">
                    {values.map((entry) => (
                      <span key={entry.currency} className="block">
                        {valuesHidden
                          ? MASK
                          : formatCurrency(entry.total_cents, entry.currency, { compact: true })}
                        {values.length > 1 && (
                          <span className="ml-1.5 font-sans text-xs text-muted-foreground">
                            {entry.currency}
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                }
                detail={
                  values.length > 1
                    ? `${values.length} currencies, reported separately`
                    : "Recorded purchase value"
                }
                icon={Wallet}
              />
            )}
            <StatCard
              label="Active warranties"
              value={activeWarranties}
              detail={
                hasWarranties
                  ? `${
                      warranties.expiring_count > 0
                        ? `${warranties.expiring_count} expiring soon`
                        : "None expiring soon"
                    } · ${warranties.expired_count} expired${
                      warranties.unknown_count ? ` · ${warranties.unknown_count} without dates` : ""
                    }`
                  : "No warranties recorded"
              }
              icon={ShieldCheck}
              to="/warranties"
            />
          </div>
          {data.financial && (
            <PurchaseReport financial={data.financial} valuesHidden={valuesHidden} />
          )}
        </div>
      )}
    </section>
  );
}

function PurchaseReport({
  financial,
  valuesHidden,
}: {
  financial: FinancialOverview;
  valuesHidden: boolean;
}) {
  const hasValues =
    financial.currency_totals.length > 0 ||
    financial.value_by_category.length > 0 ||
    financial.value_by_room.length > 0;
  const unallocated = financial.currency_totals.filter(
    (entry) => entry.purchase_unallocated_cents > 0,
  );
  const csvLink = (
    <a
      href="/api/v1/exports/inventory.csv"
      className="inline-flex min-h-11 items-center gap-1.5 text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <Download className="size-3.5" />
      Inventory CSV
    </a>
  );

  if (!hasValues) {
    return (
      <div className="flex flex-col gap-3 text-xs leading-relaxed text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium text-foreground/85">No purchase values yet.</p>
          <p className="mt-1">
            {financial.items_missing_purchase_count > 0
              ? `${financial.items_missing_purchase_count} items have missing or unresolved purchase information. Items marked not applicable are excluded.`
              : "Purchase details appear here when recorded."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {financial.items_missing_purchase_count > 0 && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/items?purchase_info=missing">Review missing</Link>
            </Button>
          )}
          {csvLink}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {financial.currency_totals.slice(0, 2).map((entry) => (
          <div key={entry.currency} className="rounded-2xl border border-border/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                {entry.currency}
              </p>
              <Badge variant="outline">{pluralize(entry.purchase_item_count, "priced item")}</Badge>
            </div>
            <p className="mt-4 text-2xs uppercase tracking-[0.1em] text-muted-foreground">
              Purchase
            </p>
            <p className="mt-1 font-display text-[1.55rem] leading-none tracking-[-0.03em] tabular-nums">
              {valuesHidden
                ? MASK
                : formatCurrency(entry.purchase_total_cents, entry.currency, { compact: true })}
            </p>
            <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
              {entry.purchase_item_count} items with purchase data. Values are not converted
              between currencies.
            </p>
          </div>
        ))}
        <div className="rounded-2xl border border-border/60 p-4">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <p className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Missing purchase info
            </p>
          </div>
          <p className="mt-4 font-display text-[2rem] leading-none tracking-[-0.03em] tabular-nums">
            {financial.items_missing_purchase_count}
          </p>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            Items without recorded purchase details and not marked not applicable. Explicitly
            Unknown remains unresolved.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="outline" size="sm" asChild>
              <Link to="/items?purchase_info=missing">Review missing</Link>
            </Button>
            {csvLink}
          </div>
        </div>
      </div>

      {(financial.value_by_category.length > 0 ||
        financial.value_by_room.length > 0 ||
        unallocated.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {financial.value_by_category.length > 0 && (
            <BreakdownTable
              title="Purchases by category"
              rows={financial.value_by_category}
              valuesHidden={valuesHidden}
            />
          )}
          {financial.value_by_room.length > 0 && (
            <BreakdownTable
              title="Purchases by room"
              rows={financial.value_by_room}
              valuesHidden={valuesHidden}
            />
          )}
          {unallocated.length > 0 && (
            <div
              className="rounded-2xl border border-border/60 p-4 lg:col-span-2"
              data-testid="unallocated-purchases"
            >
              <p className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                Not allocated to items
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {unallocated.map((entry) => (
                  <li
                    key={entry.currency}
                    className="flex flex-wrap items-baseline justify-between gap-x-4"
                  >
                    <span className="text-muted-foreground">
                      {entry.currency} · {pluralize(entry.purchase_unallocated_count, "purchase")}
                    </span>
                    <span className="tabular-nums">
                      {valuesHidden
                        ? MASK
                        : formatCurrency(entry.purchase_unallocated_cents, entry.currency, {
                            compact: true,
                          })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
                Counted in the purchase totals but not in the category and room breakdowns:
                shared purchases, and purchases with no record of which items they paid for.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  valuesHidden,
}: {
  title: string;
  rows: FinancialOverview["value_by_category"];
  valuesHidden: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h3 className="font-display text-[1.1rem] tracking-[-0.02em]">{title}</h3>
        <ReceiptText className="size-4 text-muted-foreground" strokeWidth={1.7} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left text-xs xl:table-auto">
          <thead>
            <tr className="border-b border-border/60 text-2xs uppercase tracking-[0.1em] text-muted-foreground">
              <th className="px-2 py-2.5 font-medium sm:px-3 xl:px-4">Name</th>
              {/* On a phone the two short columns are only as wide as their values, so the
                  name gets the rest. The currency codes need no visible heading there. */}
              <th className="w-12 px-2 py-2.5 font-medium sm:w-auto sm:px-3">
                <span className="sr-only sm:not-sr-only">Currency</span>
              </th>
              <th className="w-[5.5rem] px-2 py-2.5 text-right font-medium sm:w-auto sm:px-3 xl:px-4">Purchase</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row) => (
              <tr
                key={`${row.name}-${row.currency}`}
                className="border-b border-border/40 last:border-0"
              >
                <td className="px-2 py-2.5 sm:px-3 xl:px-4">
                  <span className="block [overflow-wrap:anywhere] xl:max-w-40 xl:truncate">
                    {row.name}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {pluralize(row.item_count, "item")}
                  </span>
                </td>
                <td className="px-2 py-2.5 text-muted-foreground sm:px-3">{row.currency}</td>
                <td className="px-2 py-2.5 text-right tabular-nums sm:px-3 xl:px-4">
                  {valuesHidden
                    ? MASK
                    : formatCurrency(row.purchase_total_cents, row.currency, { compact: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
