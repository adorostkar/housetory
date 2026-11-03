import { ImageOff, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import type { ItemSummary } from "@/lib/types";
import { cn, CONDITION_LABELS, formatCurrency, formatDate } from "@/lib/utils";

export function ItemCard({ item, className }: { item: ItemSummary; className?: string }) {
  const photo = item.primary_photo;
  const price = item.purchase?.price_cents;
  const warrantyEnd = item.warranty?.end_date;

  return (
    <Link
      to={`/items/${item.id}`}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/75 bg-card/85 shadow-soft transition-[transform,border-color,box-shadow] duration-300 ease-smooth hover:-translate-y-0.5 hover:border-border hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-foreground/10 bg-background/25 text-foreground/25 backdrop-blur-sm">
              <ImageOff className="size-5" strokeWidth={1.5} />
            </span>
          </div>
        )}

        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {item.is_archived && (
              <Badge variant="secondary" className="bg-background/80 backdrop-blur-md">
                Archived
              </Badge>
            )}
            {warrantyEnd && new Date(warrantyEnd) > new Date() && (
              <Badge
                variant="secondary"
                className="gap-1 bg-background/80 backdrop-blur-md"
              >
                <ShieldCheck className="size-3 text-sage" />
                Covered
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
            <p className="shrink-0 text-[0.8rem] font-medium tabular-nums text-foreground/75">
              {formatCurrency(price, item.purchase?.currency)}
            </p>
          )}
        </div>

        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-muted-foreground">
            {item.room && <span className="truncate">{item.room.name}</span>}
            {item.room && item.location && <span className="text-border">/</span>}
            {item.location && <span className="truncate">{item.location.name}</span>}
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
}

export function ItemRow({ item }: { item: ItemSummary }) {
  const photo = item.primary_photo;
  return (
    <Link
      to={`/items/${item.id}`}
      className="group flex items-center gap-4 rounded-xl px-2 py-2.5 transition-colors hover:bg-secondary/60"
    >
      <div className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-secondary/70">
        {photo ? (
          <img
            src={photo.thumbnail_url}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="image-placeholder flex size-full items-center justify-center">
            <ImageOff className="size-4 text-foreground/25" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.88rem] font-medium">{item.name}</p>
        <p className="mt-0.5 truncate text-[0.72rem] text-muted-foreground">
          {[item.room?.name, item.location?.name].filter(Boolean).join(" · ") ||
            "No location"}{" "}
          {item.purchase?.price_cents != null && (
            <span className="text-muted-foreground/70">
              · {formatCurrency(item.purchase.price_cents, item.purchase.currency)}
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
}
