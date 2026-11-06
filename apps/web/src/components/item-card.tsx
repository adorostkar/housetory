import {
  Armchair,
  Bike,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  ClipboardCheck,
  Drill,
  HandCoins,
  Laptop,
  Package,
  ShieldCheck,
  Tv,
  Utensils,
  Wifi,
} from "lucide-react";
import { Link } from "react-router-dom";

import { BuiltinIllustration } from "@/components/builtin-illustration";
import { Badge } from "@/components/ui/badge";
import { withHousehold } from "@/lib/household-links";
import type { ItemSummary } from "@/lib/types";
import {
  cn,
  CONDITION_LABELS,
  formatCurrency,
  formatDate,
  itemContainer,
  locationLabel,
} from "@/lib/utils";

function categoryIcon(name: string | null | undefined) {
  const value = (name ?? "").toLowerCase();
  if (value.includes("drill") || value.includes("tool")) return Drill;
  if (value.includes("tv") || value.includes("television")) return Tv;
  if (value.includes("cable") || value.includes("network")) return Wifi;
  if (value.includes("bag") || value.includes("luggage")) return BriefcaseBusiness;
  if (value.includes("chair") || value.includes("furniture")) return Armchair;
  if (value.includes("camera") || value.includes("photo")) return Camera;
  if (value.includes("laptop") || value.includes("computer")) return Laptop;
  if (value.includes("kitchen") || value.includes("utensil")) return Utensils;
  if (value.includes("book")) return BookOpen;
  if (value.includes("bike") || value.includes("bicycle")) return Bike;
  return Package;
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
}: {
  item: ItemSummary;
  className?: string;
  selection?: ItemSelection;
}) {
  const photo = item.primary_photo;
  const representative = item.representative_image ?? null;
  const FallbackIcon = categoryIcon(item.category?.name);
  const container = itemContainer(item);
  const price = item.purchase?.price_cents;
  const warrantyActive =
    item.warranty?.status === "active" || item.warranty?.status === "expiring";

  const card = (
    <Link
      to={withHousehold(`/items/${item.id}`, item.household?.id)}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/75 bg-card/85 shadow-soft transition-[transform,border-color,box-shadow] duration-300 ease-smooth hover:-translate-y-0.5 hover:border-border hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        selection?.selected && "border-sage/60 shadow-lift ring-2 ring-sage/45",
        className,
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-secondary/60">
        {photo ? (
          <img
            src={photo.thumbnail_url}
            alt={item.name}
            loading="lazy"
            className="size-full object-cover transition-transform duration-700 ease-smooth group-hover:scale-[1.025]"
          />
        ) : representative?.source_type === "builtin" && representative.illustration_key ? (
          <BuiltinIllustration
            illustrationKey={representative.illustration_key}
            label={representative.label}
            className="size-full"
          />
        ) : representative?.thumbnail_url || representative?.url ? (
          <img
            src={representative.thumbnail_url ?? representative.url ?? ""}
            alt={`${item.name} ${representative.label.toLowerCase()}`}
            loading="lazy"
            className="size-full object-cover transition-transform duration-700 ease-smooth group-hover:scale-[1.025]"
          />
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-foreground/10 bg-background/25 text-foreground/25 backdrop-blur-sm">
              <FallbackIcon className="size-5" strokeWidth={1.5} />
            </span>
          </div>
        )}

        {!photo && representative && (
          <Badge
            variant="secondary"
            className="absolute bottom-3 left-3 z-10 gap-1 bg-background/85 text-[0.58rem] backdrop-blur-md"
          >
            {representative.source_type === "reference"
              ? "Reference"
              : representative.source_type === "ai"
                ? "AI illustration"
                : "Illustration"}
          </Badge>
        )}

        <div
          className={cn(
            "absolute inset-x-3 top-3 flex items-start justify-between gap-2",
            selection && "pl-8",
          )}
        >
          <div className="flex flex-wrap gap-1.5">
            {item.is_archived && (
              <Badge variant="secondary" className="bg-background/80 backdrop-blur-md">
                Archived
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
            <span className="rounded-full bg-background/80 px-2 py-0.5 text-[0.68rem] font-semibold text-foreground/80 backdrop-blur-md">
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
              <p className="mt-0.5 line-clamp-1 text-[0.75rem] text-muted-foreground">
                {[item.brand, item.model].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          {typeof price === "number" && (
            <p
              className="shrink-0 text-right text-[0.8rem] font-medium tabular-nums text-foreground/75"
              title={item.purchase?.is_shared ? "Shared purchase total" : "Purchase price"}
            >
              {formatCurrency(price, item.purchase?.currency)}
              {item.purchase?.is_shared && (
                <span className="block text-[0.6rem] font-normal text-muted-foreground">
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
                "mb-1.5 inline-flex items-center gap-1 text-[0.66rem]",
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-muted-foreground">
            {item.household && <span className="truncate">{item.household.name}</span>}
            {item.household && (item.property || item.room || container || item.location) && (
              <span className="text-border">/</span>
            )}
            {item.property && <span className="truncate">{item.property.name}</span>}
            {item.property && (item.room || container || item.location) && (
              <span className="text-border">/</span>
            )}
            {item.room && <span className="truncate">{item.room.name}</span>}
            {item.room && (container || item.location) && (
              <span className="text-border">/</span>
            )}
            {container ? (
              <span className="truncate font-medium text-foreground/75">
                {locationLabel(container)}
              </span>
            ) : (
              item.location && (
                <span className="truncate">{locationLabel(item.location)}</span>
              )
            )}
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
                <span className="text-[0.68rem] text-muted-foreground">
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
      <label className="absolute left-3 top-3 z-20 flex size-6 cursor-pointer items-center justify-center rounded-md border border-border/80 bg-background/90 shadow-sm backdrop-blur-md">
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
}: {
  item: ItemSummary;
  selection?: ItemSelection;
}) {
  const photo = item.primary_photo;
  const representative = item.representative_image ?? null;
  const FallbackIcon = categoryIcon(item.category?.name);
  const onLoan = item.on_loan_quantity ?? 0;
  const path =
    item.location_path.length > 0
      ? [
          item.household?.name,
          item.property?.name,
          item.room?.name,
          ...item.location_path.map((entry) => locationLabel(entry)),
        ]
          .filter(Boolean)
          .join(" / ")
      : [
          item.household?.name,
          item.property?.name,
          item.room?.name,
          item.location ? locationLabel(item.location) : null,
        ]
          .filter(Boolean)
          .join(" / ");
  const row = (
    <Link
      to={withHousehold(`/items/${item.id}`, item.household?.id)}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-secondary/60",
        selection?.selected && "bg-sage-soft/45 ring-1 ring-sage/35",
      )}
    >
      <div className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-secondary/70">
        {photo ? (
          <img
            src={photo.thumbnail_url}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : representative?.source_type === "builtin" &&
          representative.illustration_key ? (
          <BuiltinIllustration
            illustrationKey={representative.illustration_key}
            label={representative.label}
            className="size-full"
          />
        ) : representative?.thumbnail_url || representative?.url ? (
          <img
            src={representative.thumbnail_url ?? representative.url ?? ""}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <FallbackIcon className="size-4 text-foreground/25" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-[0.88rem] font-medium">{item.name}</p>
          <Badge variant="outline" className="shrink-0 tabular-nums">
            ×{item.quantity}
          </Badge>
          {onLoan > 0 && (
            <Badge variant="brass" className="shrink-0">
              {onLoan} on loan · {Math.max(0, item.quantity - onLoan)} at home
            </Badge>
          )}
          {item.is_archived && <Badge variant="secondary">Archived</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[0.72rem] text-muted-foreground">
          {path || "No location"}
          {item.category ? ` · ${item.category.name}` : ""}{" "}
          {item.purchase?.price_cents != null && (
            <span className="text-muted-foreground/70">
              · {formatCurrency(item.purchase.price_cents, item.purchase.currency)}
              {item.purchase.is_shared ? " shared" : ""}
            </span>
          )}
        </p>
      </div>
      {item.warranty?.end_date && (
        <span className="hidden text-[0.68rem] text-muted-foreground sm:block">
          Until {formatDate(item.warranty.end_date)}
        </span>
      )}
    </Link>
  );
  if (!selection) return row;
  return (
    <div className="relative flex min-w-0 items-center">
      <label className="ml-2 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-card/70">
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
