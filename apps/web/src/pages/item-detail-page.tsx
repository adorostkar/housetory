import { useMutation } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  ChevronRight,
  FileText,
  Hash,
  MapPin,
  MoreHorizontal,
  Pencil,
  ReceiptText,
  ShieldCheck,
  Tag,
  Trash2,
  Wallet,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { ItemDocuments } from "@/components/item-documents";
import { PageHeader } from "@/components/page-header";
import { PhotoGallery } from "@/components/photo-gallery";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getApiErrorMessage } from "@/lib/api";
import { useInvalidateInventory, useItem, useLocations } from "@/lib/queries";
import type { ItemDetail } from "@/lib/types";
import {
  WARRANTY_STATUS_LABELS,
  WARRANTY_STATUS_TONE,
  warrantyRemainingLabel,
} from "@/lib/labels";
import {
  CONDITION_LABELS,
  formatCurrency,
  formatDate,
  formatRelativeDate,
  locationPath,
} from "@/lib/utils";
import { useState } from "react";

export function ItemDetailPage() {
  const { itemId = "" } = useParams();
  const itemQuery = useItem(itemId);
  const locationsQuery = useLocations(itemQuery.data?.item.room?.id);
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const archive = useMutation({
    mutationFn: (item: ItemDetail) =>
      api.patch(`/items/${item.id}`, { is_archived: !item.is_archived }),
    onSuccess: (_data, item) => {
      invalidate();
      toast.success(item.is_archived ? "Item restored" : "Item archived");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/items/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success("Item deleted");
      navigate("/items", { replace: true });
    },
  });

  if (itemQuery.isPending) return <ItemDetailSkeleton />;
  if (itemQuery.isError) {
    return (
      <ErrorState
        title="This item is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void itemQuery.refetch()}
      />
    );
  }

  const item = itemQuery.data.item;
  const warrantyStatus = item.warranty?.status ?? "unknown";
  const locationTrail = item.location
    ? locationPath(locationsQuery.data?.items ?? [], item.location.id)
    : [];

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow={item.category?.name ?? "Item"}
        title={item.name}
        description={
          [item.brand, item.model].filter(Boolean).join(" · ") ||
          item.description ||
          undefined
        }
        backTo="/items"
        backLabel="All items"
        actions={
          <>
            {item.is_archived && <Badge variant="secondary">Archived</Badge>}
            <Button variant="outline" asChild>
              <Link to={`/items/${item.id}/edit`}>
                <Pencil />
                Edit
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Item options">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={archive.isPending}
                  onSelect={() => archive.mutate(item)}
                >
                  {item.is_archived ? <ArchiveRestore /> : <Archive />}
                  {item.is_archived ? "Restore item" : "Archive item"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete item
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,1fr)]">
        <div className="min-w-0 space-y-6">
          <PhotoGallery item={item} />

          <section className="surface p-5 sm:p-6">
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              About this item
            </h2>
            {item.description ? (
              <p className="mt-3 whitespace-pre-line text-pretty text-[0.9rem] leading-[1.75] text-muted-foreground">
                {item.description}
              </p>
            ) : (
              <p className="mt-3 text-[0.85rem] leading-relaxed text-muted-foreground">
                No description yet.{" "}
                <Link to={`/items/${item.id}/edit`} className="underline underline-offset-4 hover:text-foreground">
                  Add a little context
                </Link>
                .
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                Details
              </h2>
              <Link
                to={`/items/${item.id}/edit`}
                className="text-[0.7rem] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Edit
              </Link>
            </div>
            <dl className="space-y-4">
              <InfoRow icon={MapPin} label="Place">
                {item.room ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Link
                      to={`/rooms/${item.room.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {item.room.name}
                    </Link>
                    {locationTrail.length > 0
                      ? locationTrail.map((location) => (
                          <span
                            key={location.id}
                            className="inline-flex items-center gap-1"
                          >
                            <ChevronRight className="size-3 text-muted-foreground/50" />
                            <Link
                              to={`/rooms/${item.room?.id}?location_id=${location.id}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {location.name}
                            </Link>
                          </span>
                        ))
                      : item.location && (
                          <>
                            <ChevronRight className="size-3 text-muted-foreground/50" />
                            <span>{item.location.name}</span>
                          </>
                        )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
              </InfoRow>

              <InfoRow icon={Tag} label="Category">
                {item.category ? (
                  <Link
                    to={`/items?category_id=${item.category.id}`}
                    className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
                  >
                    <span
                      className="size-1.5 rounded-full bg-current opacity-70"
                      style={item.category.color ? { color: item.category.color } : undefined}
                    />
                    {item.category.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Uncategorised</span>
                )}
              </InfoRow>

              <InfoRow icon={Wallet} label="Quantity">
                {item.quantity} · {CONDITION_LABELS[item.condition]}
              </InfoRow>

              <InfoRow icon={Wallet} label="Current value">
                {item.current_value_cents != null ? (
                  <span>
                    {formatCurrency(
                      item.current_value_cents,
                      item.current_value_currency,
                    )}
                    <span className="ml-1.5 text-[0.68rem] text-muted-foreground">
                      estimate
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not estimated</span>
                )}
              </InfoRow>

              {item.serial_number && (
                <InfoRow icon={Hash} label="Serial">
                  <span className="break-all">{item.serial_number}</span>
                </InfoRow>
              )}

              <InfoRow icon={CalendarDays} label="Added">
                {formatRelativeDate(item.created_at)}
              </InfoRow>
            </dl>

            {item.tags.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-1.5 border-t border-border/60 pt-4">
                {item.tags.map((tag) => (
                  <Link key={tag.id} to={`/items?tag_id=${tag.id}`}>
                    <Badge variant="outline" className="hover:bg-secondary">
                      {tag.name}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="surface p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ReceiptText className="size-4 text-muted-foreground" strokeWidth={1.7} />
                <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Purchase
                </h2>
              </div>
              {item.purchase?.is_shared && (
                <Badge variant="brass">Shared · {item.purchase.item_count}</Badge>
              )}
            </div>
            {item.purchase ? (
              <>
                {item.purchase.price_cents != null && (
                  <p className="font-display text-[2rem] leading-none tracking-[-0.03em] tabular-nums">
                    {formatCurrency(item.purchase.price_cents, item.purchase.currency)}
                  </p>
                )}
                {item.purchase.is_shared && (
                  <p className="mt-1.5 text-[0.68rem] leading-relaxed text-muted-foreground">
                    This amount is the shared purchase total, not a per-item price.
                  </p>
                )}
                <dl className="mt-4 space-y-2.5 text-[0.8rem]">
                  {(item.purchase.merchant || item.purchase.vendor) && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Merchant</dt>
                      <dd className="text-right">
                        {item.purchase.merchant || item.purchase.vendor}
                      </dd>
                    </div>
                  )}
                  {item.purchase.purchase_date && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Purchased</dt>
                      <dd>{formatDate(item.purchase.purchase_date)}</dd>
                    </div>
                  )}
                  {item.purchase.order_number && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Order</dt>
                      <dd className="break-all text-right">{item.purchase.order_number}</dd>
                    </div>
                  )}
                </dl>
                {item.purchase.notes && (
                  <p className="mt-3 whitespace-pre-line border-t border-border/60 pt-3 text-[0.75rem] leading-relaxed text-muted-foreground">
                    {item.purchase.notes}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/60 pt-3 text-[0.72rem]">
                  {item.purchase.receipt ? (
                    <Link
                      to={`/documents/${item.purchase.receipt.id}`}
                      className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      <FileText className="size-3.5" />
                      {item.purchase.receipt.title}
                    </Link>
                  ) : (
                    <Link
                      to={`/items/${item.id}/edit`}
                      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Link a receipt
                    </Link>
                  )}
                  <Link
                    to={`/purchases?q=${encodeURIComponent(
                      item.purchase.merchant || item.purchase.vendor || "",
                    )}`}
                    className="ml-auto text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    All purchases
                  </Link>
                </div>
              </>
            ) : (
              <p className="text-[0.8rem] leading-relaxed text-muted-foreground">
                No purchase information recorded.{" "}
                <Link
                  to={`/items/${item.id}/edit`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Add details
                </Link>
              </p>
            )}
          </section>

          <section className="surface p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" strokeWidth={1.7} />
                <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Warranty
                </h2>
              </div>
              <Badge variant={WARRANTY_STATUS_TONE[warrantyStatus]}>
                {WARRANTY_STATUS_LABELS[warrantyStatus]}
              </Badge>
            </div>
            {item.warranty ? (
              <>
              <dl className="space-y-2.5 text-[0.8rem]">
                {item.warranty.provider && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd className="text-right">{item.warranty.provider}</dd>
                  </div>
                )}
                {item.warranty.start_date && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Starts</dt>
                    <dd>{formatDate(item.warranty.start_date)}</dd>
                  </div>
                )}
                {item.warranty.duration_months != null && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Duration</dt>
                    <dd>{item.warranty.duration_months} months</dd>
                  </div>
                )}
                {item.warranty.end_date && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Ends</dt>
                    <dd>{formatDate(item.warranty.end_date)}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="text-right">
                    {warrantyRemainingLabel(
                      item.warranty.days_remaining,
                      item.warranty.status,
                    )}
                  </dd>
                </div>
              </dl>
              {item.warranty.notes && (
                <p className="mt-3 whitespace-pre-line border-t border-border/60 pt-3 text-[0.75rem] leading-relaxed text-muted-foreground">
                  {item.warranty.notes}
                </p>
              )}
              {item.warranty.document && (
                <Link
                  to={`/documents/${item.warranty.document.id}`}
                  className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3 text-[0.72rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <FileText className="size-3.5" />
                  {item.warranty.document.title}
                </Link>
              )}
              </>
            ) : (
              <p className="text-[0.8rem] leading-relaxed text-muted-foreground">
                No warranty recorded.{" "}
                <Link
                  to={`/items/${item.id}/edit`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Add one
                </Link>
              </p>
            )}
          </section>

        </aside>
      </div>

      <div className="mt-8">
        <ItemDocuments item={item} />
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${item.name}?`}
        description="The item and its photographs will be permanently removed. Documents used only by this item are removed too."
        confirmLabel="Delete item"
        onConfirm={async () => {
          await remove.mutateAsync(item.id);
        }}
      />
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3 text-[0.82rem] leading-relaxed">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" strokeWidth={1.7} />
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function ItemDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-12 w-1/2 max-w-md" />
      <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,1fr)]">
        <div className="space-y-6">
          <Skeleton className="aspect-[4/3] rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
