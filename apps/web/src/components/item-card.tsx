import { ClipboardCheck, HandCoins, ShieldCheck } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { CategoryIcon } from "@/components/category-icon";
import { itemLocationPath, useItemPathScope } from "@/components/item-location-path";
import { Badge } from "@/components/ui/badge";
import { ITEM_DISPOSITION_LABELS } from "@/lib/labels";
import { itemHref, rememberListScroll, type ItemOrigin } from "@/lib/navigation";
import { holdRecentItemsSnapshot } from "@/lib/recent-items";
import type { ItemListEntry } from "@/lib/types";
import {
  cn,
  CONDITION_LABELS,
  formatCurrency,
  formatDate,
  itemContainer,
} from "@/lib/utils";

/** An item is being opened from a list: the list keeps its place and its order. */
function leaveList(origin: ItemOrigin | null) {
  rememberListScroll(origin);
  holdRecentItemsSnapshot();
}

interface ItemSelection {
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ItemCard({
  item,
  className,
  selection,
  origin,
  hidePurchaseValue = false,
}: {
  item: ItemListEntry;
  className?: string;
  selection?: ItemSelection;
  origin?: ItemOrigin | null;
  hidePurchaseValue?: boolean;
}) {
  const photo = item.primary_photo;
  const representative = item.representative_image ?? null;
  const place = itemContainer(item) ?? item.location;
  const path = itemLocationPath(item, useItemPathScope(), place ? [place] : []);
  const shortened = path.short !== path.full;
  const price = item.purchase?.price_cents;
  const warrantyActive =
    item.warranty?.status === "active" || item.warranty?.status === "expiring";

  const card = (
    <Link
      to={itemHref(item.id, origin, item.household?.id)}
      onClick={() => leaveList(origin ?? null)}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/75 bg-card/85 shadow-soft transition-[transform,border-color,box-shadow] duration-300 ease-smooth hover:-translate-y-0.5 hover:border-border hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        selection?.selected && "border-sage/60 shadow-lift ring-2 ring-sage/45",
        className,
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-secondary/60">
        {photo ? (
          <div className="flex size-full items-center justify-center bg-secondary/30 p-4">
            <img
              src={photo.thumbnail_url}
              alt={item.name}
              loading="lazy"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : representative?.thumbnail_url || representative?.url ? (
          <div
            className={cn(
              "flex size-full items-center justify-center p-4",
              representative.source_type === "reference" ? "bg-white" : "bg-secondary/30",
            )}
          >
            <img
              src={representative.thumbnail_url ?? representative.url ?? ""}
              alt={`${item.name} ${representative.label.toLowerCase()}`}
              loading="lazy"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-foreground/10 bg-background/25 text-foreground/25 backdrop-blur-sm">
              <CategoryIcon
                category={item.category?.name}
                className="size-5"
              />
            </span>
          </div>
        )}

        {!photo && representative && (
          <Badge
            variant="secondary"
            className="absolute bottom-3 left-3 z-10 gap-1 bg-background/85 text-2xs backdrop-blur-md"
          >
            {representative.source_type === "reference"
              ? "Reference"
              : "AI illustration"}
          </Badge>
        )}

        <div
          className={cn(
            "absolute inset-x-3 top-3 flex items-start justify-between gap-2",
            selection && "pl-12 sm:pl-8",
          )}
        >
          <div className="flex flex-wrap gap-1.5">
            {item.is_archived && (
              <Badge variant="secondary" className="bg-background/80 backdrop-blur-md">
                {item.disposition
                  ? ITEM_DISPOSITION_LABELS[item.disposition]
                  : "Archived"}
              </Badge>
            )}
            {warrantyActive && (
              <Badge
                variant="secondary"
                className="gap-1 bg-background/80 backdrop-blur-md"
              >
                <ShieldCheck className="size-3 text-sage" />
                {item.warranty?.status === "expiring" ? "Expiring" : "Covered"}
              </Badge>
            )}
            {Boolean(item.on_loan_quantity) && (
              <Badge
                variant="secondary"
                className="gap-1 bg-background/80 backdrop-blur-md"
                title="Owned quantity includes loaned stock"
              >
                <HandCoins className="size-3 text-brass" />
                {item.on_loan_quantity} on loan
              </Badge>
            )}
          </div>
          {item.quantity > 1 && (
            <span className="rounded-full bg-background/80 px-2 py-0.5 text-2xs font-semibold text-foreground/80 backdrop-blur-md">
              ×{item.quantity}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="line-clamp-2 text-[0.95rem] font-medium leading-snug tracking-[-0.005em] text-foreground">
              {item.name}
            </h3>
            {(item.brand || item.model) && (
              <p className="mt-0.5 line-clamp-1 text-2xs text-muted-foreground">
                {[item.brand, item.model].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          {typeof price === "number" && (
            <p
              className="shrink-0 text-right text-xs font-medium tabular-nums text-foreground/75"
              title={item.purchase?.is_shared ? "Shared purchase transaction total" : "Purchase transaction total"}
            >
              {hidePurchaseValue ? "••••••" : formatCurrency(price, item.purchase?.currency)}
              {item.purchase?.is_shared && (
                <span className="block text-2xs font-normal text-muted-foreground">
                  shared
                </span>
              )}
            </p>
          )}
        </div>

        <div className="mt-auto pt-4">
          {item.last_verified && (
            <p
              className={cn(
                "mb-1.5 inline-flex items-center gap-1 text-2xs",
                item.last_verified.stale ? "text-brass" : "text-muted-foreground",
              )}
              title={item.last_verified.stale_reason ?? "Last stocktake check"}
            >
              <ClipboardCheck className="size-3" />
              Checked {formatDate(item.last_verified.at)}
              {item.last_verified.status === "present"
                ? ""
                : ` · ${item.last_verified.status.replace("_", " ")}`}
              {item.last_verified.stale ? " · changed" : ""}
            </p>
          )}
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground"
            title={path.full || undefined}
          >
            {shortened && <span className="sr-only">{path.full}</span>}
            <span className="contents" aria-hidden={shortened || undefined}>
              {path.segments.map((segment, index) => (
                <React.Fragment key={segment.key}>
                  {index > 0 && <span className="text-border">/</span>}
                  <span
                    className={cn(
                      "truncate",
                      segment.place?.is_container && "font-medium text-foreground/75",
                    )}
                  >
                    {segment.text}
                  </span>
                </React.Fragment>
              ))}
            </span>
            {!item.room && !item.location && (
              <span className="italic opacity-80">No place assigned</span>
            )}
          </div>

          {(item.category || item.tags.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {item.category && (
                <Badge variant="outline" className="gap-1.5">
                  <span
                    className="size-1.5 rounded-full bg-current opacity-70"
                    style={item.category.color ? { color: item.category.color } : undefined}
                  />
                  {item.category.name}
                </Badge>
              )}
              {item.tags.slice(0, 2).map((tag) => (
                <Badge key={tag.id} variant="outline">
                  {tag.name}
                </Badge>
              ))}
              {item.tags.length > 2 && (
                <span className="text-2xs text-muted-foreground">
                  +{item.tags.length - 2}
                </span>
              )}
              {item.condition !== "good" && item.condition !== "unknown" && !item.category && (
                <Badge variant="outline">{CONDITION_LABELS[item.condition]}</Badge>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  );

  if (!selection) return card;
  return (
    <div className="relative min-w-0">
      <label className="absolute left-3 top-3 z-20 flex size-11 cursor-pointer items-center justify-center rounded-md border border-border/80 bg-background/90 shadow-sm backdrop-blur-md sm:size-6 coarse:!size-11">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
          checked={selection.selected}
          disabled={selection.disabled}
          onChange={selection.onToggle}
          aria-label={`Select ${item.name}`}
        />
      </label>
      {card}
    </div>
  );
}

export function ItemRow({
  item,
  selection,
  origin,
  hidePurchaseValue = false,
}: {
  item: ItemListEntry;
  selection?: ItemSelection;
  origin?: ItemOrigin | null;
  hidePurchaseValue?: boolean;
}) {
  const photo = item.primary_photo;
  const representative = item.representative_image ?? null;
  const onLoan = item.on_loan_quantity ?? 0;
  const path = itemLocationPath(
    item,
    useItemPathScope(),
    item.location_path.length > 0 ? item.location_path : item.location ? [item.location] : [],
  );
  const row = (
    <Link
      to={itemHref(item.id, origin, item.household?.id)}
      onClick={() => leaveList(origin ?? null)}
      className={cn(
        "group flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        selection?.selected && "bg-sage-soft/45 ring-1 ring-sage/35",
      )}
    >
      <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-secondary/70">
        {photo ? (
          <img
            src={photo.thumbnail_url}
            alt=""
            loading="lazy"
            className="size-full bg-secondary/30 object-contain p-1"
          />
        ) : representative?.thumbnail_url || representative?.url ? (
          <img
            src={representative.thumbnail_url ?? representative.url ?? ""}
            alt=""
            loading="lazy"
            className={cn(
              "size-full object-contain p-1",
              representative.source_type === "reference" ? "bg-white" : "bg-secondary/30",
            )}
          />
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <CategoryIcon
              category={item.category?.name}
              className="size-4 text-foreground/25"
            />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          {/* The name may take two lines; a long name is not cut to one. */}
          <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug [overflow-wrap:anywhere]">
            {item.name}
          </p>
          {item.quantity > 1 && (
            <Badge variant="outline" className="shrink-0 tabular-nums">
              ×{item.quantity}
            </Badge>
          )}
        </div>
        {(onLoan > 0 || item.is_archived) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            {onLoan > 0 && (
              <Badge variant="brass">
                {onLoan} on loan · {Math.max(0, item.quantity - onLoan)} at home
              </Badge>
            )}
            {item.is_archived && (
              <Badge variant="secondary">
                {item.disposition
                  ? ITEM_DISPOSITION_LABELS[item.disposition]
                  : "Archived"}
              </Badge>
            )}
          </div>
        )}
        <p
          className="mt-0.5 truncate text-2xs text-muted-foreground"
          title={path.full || undefined}
        >
          {path.short !== path.full ? (
            <>
              <span className="sr-only">{path.full}</span>
              <span aria-hidden>{path.short || "No location"}</span>
            </>
          ) : (
            path.short || "No location"
          )}
          {/* Category and price are extra; they show where the row has room for them. */}
          <span className="hidden sm:inline">
            {item.category ? ` · ${item.category.name}` : ""}
            {item.purchase?.price_cents != null &&
              ` · ${
                hidePurchaseValue
                  ? "••••••"
                  : formatCurrency(item.purchase.price_cents, item.purchase.currency)
              }${item.purchase.is_shared ? " shared" : ""}`}
          </span>
        </p>
      </div>
      {item.warranty?.end_date && (
        <span className="hidden shrink-0 text-2xs text-muted-foreground sm:block">
          Until {formatDate(item.warranty.end_date)}
        </span>
      )}
    </Link>
  );
  if (!selection) return row;
  return (
    <div className="relative flex min-w-0 items-center">
      <label className="ml-1 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-card/70 sm:size-7 coarse:!size-11">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
          checked={selection.selected}
          disabled={selection.disabled}
          onChange={selection.onToggle}
          aria-label={`Select ${item.name}`}
        />
      </label>
      <div className="min-w-0 flex-1">{row}</div>
    </div>
  );
}
