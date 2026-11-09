import { useMutation } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  Copy,
  FileText,
  HandCoins,
  Hash,
  History,
  MapPin,
  MoreHorizontal,
  Pencil,
  ReceiptText,
  ShieldCheck,
  Tag,
  Trash2,
  Wallet,
} from "lucide-react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";

import { ActivityTimeline } from "@/components/activity-timeline";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { ItemDispositionDialog } from "@/components/item-disposition-dialog";
import { ItemDocumentsAndManuals } from "@/components/item-documents-manuals";
import { ItemLoanStatus } from "@/components/item-loan-status";
import { ItemStorageSection } from "@/components/item-storage-section";
import { LendLoanDialog, ReturnLoanDialog } from "@/components/loan-dialogs";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-layout";
import {
  ItemDetailTabList,
  parseItemDetailTab,
  type ItemDetailTab,
} from "@/components/item-detail-tabs";
import { ItemImageControls } from "@/components/item-image-controls";
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
import { api, getApiErrorMessage } from "@/lib/api";
import {
  useCanWrite,
  useInvalidateInventory,
  useItem,
  useItemHistory,
  useItemLoans,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type { ItemDetail, Loan } from "@/lib/types";
import {
  ITEM_DISPOSITION_LABELS,
  WARRANTY_STATUS_LABELS,
  WARRANTY_STATUS_TONE,
  warrantyRemainingLabel,
} from "@/lib/labels";
import { appendOrigin, readOrigin } from "@/lib/navigation";
import {
  CONDITION_LABELS,
  formatCurrency,
  formatDate,
  formatRelativeDate,
  locationLabel,
  locationPath,
  roomPath,
} from "@/lib/utils";
import { Fragment, useState } from "react";
import { InfoRow, LoanQuantity } from "@/pages/item-detail-parts";

export function ItemDetailPage() {
  const { itemId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseItemDetailTab(searchParams.get("tab"));
  const selectTab = (next: ItemDetailTab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  const origin = readOrigin(searchParams);
  const itemQuery = useItem(itemId);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations(itemQuery.data?.item.room?.id);
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const canWrite = useCanWrite();
  const loansQuery = useItemLoans(itemId);
  const historyQuery = useItemHistory(itemId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dispositionOpen, setDispositionOpen] = useState(false);
  const [lendOpen, setLendOpen] = useState(false);
  const [returnLoan, setReturnLoan] = useState<Loan | null>(null);

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

  if (itemQuery.isPending) return <PageSkeleton variant="detail" />;
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
  const loanSummary = loansQuery.data;
  const onLoan = loanSummary?.on_loan_quantity ?? 0;
  const available = loanSummary?.available_quantity ?? item.quantity;
  const warrantyStatus = item.warranty?.status ?? "unknown";
  const locationTrail = item.location
    ? locationPath(locationsQuery.data?.items ?? [], item.location.id)
    : [];
  const roomTrail = item.room
    ? roomPath(roomsQuery.data?.items ?? [], item.room.id)
    : [];
  const purchaseAllocations =
    item.purchase?.allocations.filter(
      (allocation) => allocation.item_id === item.id,
    ) ?? [];
  const purchaseUnitCents =
    item.purchase?.price_cents != null &&
    !item.purchase.is_shared &&
    purchaseAllocations.length === 0 &&
    item.quantity > 1
      ? Math.round(item.purchase.price_cents / item.quantity)
      : null;
  const purchaseUnitIsRounded =
    purchaseUnitCents != null &&
    item.purchase?.price_cents != null &&
    item.purchase.price_cents % item.quantity !== 0;

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
        backTo={origin?.path ?? "/items"}
        backLabel={origin ? `Back to ${origin.label}` : "All items"}
        actionsPlacement="title"
        titleAddon={
          loanSummary ? (
            <ItemLoanStatus
              ownedQuantity={item.quantity}
              atHomeQuantity={available}
              loans={loanSummary.loans}
              canWrite={canWrite}
              onReturnLoan={setReturnLoan}
            />
          ) : undefined
        }
        actions={
          <>
            {item.is_archived && (
              <Badge
                variant="secondary"
                title={
                  item.disposed_on ? `Recorded ${item.disposed_on}` : undefined
                }
              >
                {item.disposition
                  ? ITEM_DISPOSITION_LABELS[item.disposition]
                  : "Archived"}
              </Badge>
            )}
            {canWrite && (
              <>
                {!item.is_archived && (
                  <Button
                    variant="outline"
                    disabled={available <= 0}
                    title={
                      available <= 0
                        ? "All owned units are currently on loan."
                        : "Record a borrower and due date without moving the item."
                    }
                    onClick={() => setLendOpen(true)}
                  >
                    <HandCoins />
                    Lend
                  </Button>
                )}
                <Button variant="outline" asChild>
                  <Link to={`/insurance?item_ids=${item.id}`}>
                    <ShieldCheck />
                    Insurance
                  </Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link to={appendOrigin(`/items/${item.id}/edit`, origin)}>
                    <Pencil />
                    Edit
                  </Link>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Item options"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!item.is_archived && (
                      <DropdownMenuItem asChild>
                        <Link
                          to={appendOrigin(
                            `/items/new?duplicate_of=${item.id}`,
                            origin,
                          )}
                        >
                          <Copy />
                          Duplicate item
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={
                        archive.isPending ||
                        onLoan > 0 ||
                        Boolean(item.storage?.active)
                      }
                      onSelect={() => {
                        if (item.is_archived) archive.mutate(item);
                        else setDispositionOpen(true);
                      }}
                    >
                      {item.is_archived ? <ArchiveRestore /> : <Archive />}
                      {item.is_archived
                        ? "Restore item"
                        : "Mark as no longer owned"}
                    </DropdownMenuItem>
                    {item.storage?.active && (
                      <p className="px-2 py-1 text-2xs leading-relaxed text-muted-foreground">
                        Remove storage capability before archiving or deleting
                        this item.
                      </p>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      disabled={onLoan > 0 || Boolean(item.storage?.active)}
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <Trash2 />
                      Delete item
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8">
        <div className="min-w-0 space-y-4 lg:sticky lg:top-20">
          <PhotoGallery
            item={item}
            representative={item.representative_image}
          />
          <ItemImageControls itemId={item.id} />

          <section className="surface p-5">
            <h2 className="mb-4 text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Key facts
            </h2>
            <dl className="space-y-4">
              <InfoRow
                icon={MapPin}
                label={onLoan > 0 ? "Usual home location" : "Place"}
              >
                {item.household && (
                  <>
                    <span className="font-medium text-foreground/80">
                      {item.household.name}
                    </span>
                    {(item.property ?? item.room) && (
                      <ChevronRight className="size-3 text-muted-foreground" />
                    )}
                  </>
                )}
                {item.property && (
                  <>
                    <span className="font-medium text-foreground/80">
                      {item.property.name}
                    </span>
                    {item.room && (
                      <ChevronRight className="size-3 text-muted-foreground" />
                    )}
                  </>
                )}
                {item.room ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {roomTrail.length > 0 ? (
                      roomTrail.map((room, index) => (
                        <span
                          key={room.id}
                          className="inline-flex items-center gap-1"
                        >
                          {index > 0 && (
                            <ChevronRight className="size-3 text-muted-foreground" />
                          )}
                          <Link
                            to={`/rooms/${room.id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {room.name}
                          </Link>
                        </span>
                      ))
                    ) : (
                      <Link
                        to={`/rooms/${item.room.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {item.room.name}
                      </Link>
                    )}
                    {locationTrail.length > 0
                      ? locationTrail.map((location) => (
                          <span
                            key={location.id}
                            className="inline-flex items-center gap-1"
                          >
                            <ChevronRight className="size-3 text-muted-foreground" />
                            <Link
                              to={
                                location.is_container
                                  ? `/containers/${location.id}`
                                  : `/rooms/${item.room?.id}?location_id=${location.id}`
                              }
                              className="underline-offset-4 hover:underline"
                            >
                              {locationLabel(location)}
                            </Link>
                          </span>
                        ))
                      : item.location && (
                          <>
                            <ChevronRight className="size-3 text-muted-foreground" />
                            <span>{locationLabel(item.location)}</span>
                          </>
                        )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
                {onLoan > 0 && (
                  <span className="mt-1.5 block text-2xs leading-relaxed text-muted-foreground">
                    {available > 0
                      ? `This home location covers only the ${available} at-home ${available === 1 ? "unit" : "units"}.`
                      : "All owned units are on loan. This is the recorded home, not a current physical location."}
                  </span>
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
                      style={
                        item.category.color
                          ? { color: item.category.color }
                          : undefined
                      }
                    />
                    {item.category.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Uncategorised</span>
                )}
              </InfoRow>

              <InfoRow icon={Wallet} label="Quantity">
                {onLoan > 0 ? (
                  <span>
                    Owned {item.quantity} ·{" "}
                    <span className="text-accent-foreground">
                      at home {available}
                    </span>{" "}
                    · <span className="text-brass">on loan {onLoan}</span>
                  </span>
                ) : (
                  <span>
                    {item.quantity} · {CONDITION_LABELS[item.condition]}
                  </span>
                )}
              </InfoRow>
            </dl>
          </section>
        </div>

        <div className="min-w-0">
          <ItemDetailTabList value={tab} onChange={selectTab} />
          <div
            role="tabpanel"
            id="item-tabpanel"
            aria-labelledby={`item-tab-${tab}`}
            tabIndex={0}
            className="space-y-4 focus-visible:outline-none"
          >
            {tab === "details" && (
              <section className="surface p-5 sm:p-6">
                <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                  About this item
                </h2>
                {item.description ? (
                  <p className="mt-3 whitespace-pre-line text-pretty text-sm leading-[1.75] text-muted-foreground">
                    {item.description}
                  </p>
                ) : (
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    No description yet.
                    {canWrite && (
                      <>
                        {" "}
                        <Link
                          to={`/items/${item.id}/edit`}
                          className="underline underline-offset-4 hover:text-foreground"
                        >
                          Add a little context
                        </Link>
                        .
                      </>
                    )}
                  </p>
                )}
              </section>
            )}

            {tab === "details" && <ItemStorageSection item={item} />}

            {tab === "details" && (
              <section className="surface p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                    Details
                  </h2>
                  {canWrite && (
                    <Link
                      to={`/items/${item.id}/edit`}
                      className="text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Edit
                    </Link>
                  )}
                </div>
                <dl className="space-y-4">
                  {item.last_verified && (
                    <InfoRow icon={ClipboardCheck} label="Last checked">
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {item.last_verified.session_id ? (
                          <Link
                            to={`/stocktake/${item.last_verified.session_id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {formatDate(item.last_verified.at)}
                          </Link>
                        ) : (
                          <span>{formatDate(item.last_verified.at)}</span>
                        )}
                        <span className="text-muted-foreground">
                          {item.last_verified.status === "quantity_discrepancy"
                            ? "quantity differs"
                            : item.last_verified.status}
                        </span>
                        {item.last_verified.stale ? (
                          <span
                            className="text-brass"
                            title={item.last_verified.stale_reason ?? undefined}
                          >
                            · changed since
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            · {item.last_verified.quantity} at home
                          </span>
                        )}
                      </span>
                    </InfoRow>
                  )}

                  {item.current_value_cents != null && (
                    <InfoRow icon={Wallet} label="Earlier estimate">
                      {item.current_value_cents == null ? (
                        <span className="text-muted-foreground">
                          Not estimated
                          <span className="ml-1.5 text-2xs">
                            (unknown, not zero)
                          </span>
                        </span>
                      ) : item.current_value_basis === "legacy_record_total" ? (
                        <span className="block">
                          <span className="block">
                            Earlier record total{" "}
                            {formatCurrency(
                              item.current_value_cents,
                              item.current_value_currency,
                            )}
                          </span>
                          <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
                            Per-unit value was not recorded. This total is
                            reported once and is not multiplied by quantity.
                          </span>
                        </span>
                      ) : (
                        <span className="block">
                          <span className="block">
                            {formatCurrency(
                              item.current_value_cents,
                              item.current_value_currency,
                            )}{" "}
                            <span className="text-2xs text-muted-foreground">
                              per unit
                            </span>
                          </span>
                          <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
                            {item.quantity} owned{" "}
                            {item.quantity === 1 ? "unit" : "units"} ×{" "}
                            {formatCurrency(
                              item.current_value_cents,
                              item.current_value_currency,
                            )}{" "}
                            ={" "}
                            <span className="font-medium text-foreground/80">
                              {formatCurrency(
                                item.current_value_total_cents ??
                                  item.current_value_cents * item.quantity,
                                item.current_value_currency,
                              )}{" "}
                              total
                            </span>
                            {onLoan > 0 && ` (includes ${onLoan} on loan)`}
                          </span>
                        </span>
                      )}
                      {item.current_value_estimate && (
                        <span className="mt-1.5 block rounded-lg border border-border/50 bg-secondary/20 px-2.5 py-2 text-2xs leading-relaxed text-muted-foreground">
                          <span className="block">
                            {item.current_value_estimate.purpose === "resale"
                              ? "Resale"
                              : "Replacement"}{" "}
                            estimate · as of{" "}
                            {formatDate(item.current_value_estimate.as_of)}
                            {item.current_value_estimate.confidence
                              ? ` · ${item.current_value_estimate.confidence} confidence`
                              : ""}
                            {" · "}
                            {item.current_value_estimate.source === "ai_web"
                              ? "AI with web search snippets"
                              : item.current_value_estimate.source === "ai"
                                ? "AI rough estimate"
                                : "manual entry"}
                          </span>
                          {item.current_value_estimate.low_cents != null &&
                            item.current_value_estimate.high_cents != null && (
                              <span className="mt-0.5 block">
                                Range{" "}
                                {formatCurrency(
                                  item.current_value_estimate.low_cents,
                                  item.current_value_estimate.currency,
                                )}{" "}
                                –{" "}
                                {formatCurrency(
                                  item.current_value_estimate.high_cents,
                                  item.current_value_estimate.currency,
                                )}{" "}
                                per unit. Estimate only; not an appraisal or
                                guaranteed insurer payout.
                              </span>
                            )}
                          {item.current_value_estimate.sources.length > 0 && (
                            <span className="mt-0.5 block">
                              {item.current_value_estimate.sources.length}{" "}
                              supporting web{" "}
                              {item.current_value_estimate.sources.length === 1
                                ? "snippet"
                                : "snippets"}{" "}
                              saved with this estimate:{" "}
                              {item.current_value_estimate.sources
                                .slice(0, 3)
                                .map((source, index) => (
                                  <Fragment key={source.url}>
                                    {index > 0 ? " · " : ""}
                                    <a
                                      href={source.url}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="underline underline-offset-4 hover:text-foreground"
                                    >
                                      {source.title}
                                    </a>
                                  </Fragment>
                                ))}
                            </span>
                          )}
                        </span>
                      )}
                    </InfoRow>
                  )}

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
            )}

            {tab === "loans" && (
              <section className="surface p-5">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <HandCoins
                      className="size-4 text-muted-foreground"
                      strokeWidth={1.7}
                    />
                    <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                      Lending
                    </h2>
                  </div>
                  {canWrite && !item.is_archived && available > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setLendOpen(true)}
                    >
                      <HandCoins />
                      Lend
                    </Button>
                  )}
                </div>
                {onLoan > 0 ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <LoanQuantity label="Owned" value={item.quantity} />
                      <LoanQuantity
                        label="At home"
                        value={available}
                        tone="sage"
                      />
                      <LoanQuantity
                        label="On loan"
                        value={onLoan}
                        tone="brass"
                      />
                    </div>
                    <ul className="mt-4 space-y-2">
                      {(loanSummary?.loans ?? []).slice(0, 4).map((loan) => (
                        <li key={loan.id}>
                          <Link
                            to={`/loans/${loan.id}`}
                            className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-2xs transition-colors hover:bg-secondary/30"
                          >
                            <span className="min-w-0 truncate">
                              {loan.borrower_name} · {loan.outstanding_quantity}{" "}
                              of {loan.quantity}
                            </span>
                            <span className="shrink-0 text-2xs text-muted-foreground">
                              {loan.due_on
                                ? `due ${formatDate(loan.due_on)}`
                                : "no due date"}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {loanSummary && loanSummary.outstanding_loan_count > 4 && (
                      <Link
                        to={`/loans?item_id=${item.id}`}
                        className="mt-3 inline-block text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        All {loanSummary.outstanding_loan_count} open loans
                      </Link>
                    )}
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {item.storage?.active
                      ? "This owned item is at home. Its contents keep separate loan records; open or view an item to see its own current lending truth."
                      : "Everything is at home. Lending records a borrower without moving this item out of its room or container."}
                  </p>
                )}
              </section>
            )}

            {tab === "details" && (
              <section className="surface p-5">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ReceiptText
                      className="size-4 text-muted-foreground"
                      strokeWidth={1.7}
                    />
                    <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                      Purchase
                    </h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.purchase?.is_shared && (
                      <Badge variant="brass">
                        Shared · {item.purchase.item_count}
                      </Badge>
                    )}
                    {item.purchase_info_status === "not_applicable" && (
                      <Badge variant="outline">Not applicable</Badge>
                    )}
                    {item.purchase_info_status === "unknown" && (
                      <Badge variant="outline">Unknown</Badge>
                    )}
                  </div>
                </div>
                {item.purchase ? (
                  <>
                    {item.purchase.price_cents != null && (
                      <>
                        <p className="text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                          {item.purchase.is_shared
                            ? "Shared purchase total"
                            : item.quantity > 1
                              ? "Package total"
                              : "Purchase total"}
                        </p>
                        <p className="mt-1 font-display text-[2rem] leading-none tracking-[-0.03em] tabular-nums">
                          {formatCurrency(
                            item.purchase.price_cents,
                            item.purchase.currency,
                          )}
                        </p>
                        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
                          Original transaction total, not a per-unit price.
                        </p>
                        {purchaseUnitCents != null && (
                          <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
                            {purchaseUnitIsRounded ? "≈ " : ""}
                            {formatCurrency(
                              purchaseUnitCents,
                              item.purchase.currency,
                            )}{" "}
                            effective per unit across {item.quantity} owned
                            units.
                          </p>
                        )}
                      </>
                    )}
                    {item.purchase.is_shared && (
                      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
                        This transaction includes {item.purchase.item_count}{" "}
                        linked items; it is not multiplied by quantity. Reviewed
                        item allocations are shown separately.
                      </p>
                    )}
                    {(() => {
                      const allocations = item.purchase.allocations.filter(
                        (allocation) => allocation.item_id === item.id,
                      );
                      const total = allocations.reduce(
                        (sum, allocation) =>
                          sum + (allocation.allocated_cents ?? 0),
                        0,
                      );
                      if (allocations.length === 0) return null;
                      return (
                        <div className="mt-2 rounded-lg border border-border/60 bg-secondary/25 px-3 py-2 text-2xs">
                          <p className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">
                              Reviewed item allocation
                            </span>
                            <span className="tabular-nums">
                              {formatCurrency(total, item.purchase.currency)}
                            </span>
                          </p>
                          <p className="mt-0.5 text-muted-foreground">
                            {allocations
                              .map(
                                (allocation) =>
                                  `${allocation.description} ×${allocation.quantity}`,
                              )
                              .join(" · ")}
                          </p>
                        </div>
                      );
                    })()}
                    <dl className="mt-4 space-y-2.5 text-xs">
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
                          <dd className="break-all text-right">
                            {item.purchase.order_number}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {item.purchase_info_missing_fields.length > 0 && (
                      <p className="mt-3 rounded-lg border border-brass/20 bg-brass-soft/40 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                        Missing from this recorded purchase:{" "}
                        {item.purchase_info_missing_fields
                          .map((field) =>
                            field === "date" ? "purchase date" : "price",
                          )
                          .join(" and ")}
                        . It remains in the missing-information review until
                        completed or explicitly marked unknown/not applicable.
                      </p>
                    )}
                    {item.purchase.notes && (
                      <p className="mt-3 whitespace-pre-line border-t border-border/60 pt-3 text-2xs leading-relaxed text-muted-foreground">
                        {item.purchase.notes}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/60 pt-3 text-2xs">
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
                  <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                    <p>
                      {item.purchase_info_status === "not_applicable"
                        ? "Purchase information is marked not applicable for this item."
                        : item.purchase_info_status === "unknown"
                          ? "Purchase information is explicitly marked unknown and still unresolved."
                          : "No purchase information recorded."}
                    </p>
                    <p className="text-2xs">
                      <Link
                        to={`/items/${item.id}/edit`}
                        className="underline underline-offset-4 hover:text-foreground"
                      >
                        {item.purchase_info_status === "not_applicable"
                          ? "Change this status or add details"
                          : "Add details or change the status"}
                      </Link>
                    </p>
                  </div>
                )}
              </section>
            )}

            {tab === "documents" && (
              <section className="surface p-5">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      className="size-4 text-muted-foreground"
                      strokeWidth={1.7}
                    />
                    <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                      Warranty
                    </h2>
                  </div>
                  <Badge variant={WARRANTY_STATUS_TONE[warrantyStatus]}>
                    {WARRANTY_STATUS_LABELS[warrantyStatus]}
                  </Badge>
                </div>
                {item.warranty ? (
                  <>
                    <dl className="space-y-2.5 text-xs">
                      {item.warranty.provider && (
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Provider</dt>
                          <dd className="text-right">
                            {item.warranty.provider}
                          </dd>
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
                      <p className="mt-3 whitespace-pre-line border-t border-border/60 pt-3 text-2xs leading-relaxed text-muted-foreground">
                        {item.warranty.notes}
                      </p>
                    )}
                    {item.warranty.document && (
                      <Link
                        to={`/documents/${item.warranty.document.id}`}
                        className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3 text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        <FileText className="size-3.5" />
                        {item.warranty.document.title}
                      </Link>
                    )}
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
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
            )}

            {tab === "documents" && <ItemDocumentsAndManuals item={item} />}
            {tab === "history" && (
              <section className="surface mt-4 p-5 sm:p-6">
                <div className="flex items-center gap-2">
                  <History className="size-4 text-muted-foreground" />
                  <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                    History
                  </h2>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                  Moves and lending changes, with household member, time and
                  preserved place names. Undo creates a new compensating event
                  and is only offered while it is safe. If the original storage
                  place was recoverably deleted, one item can be returned after
                  an explicit container-restore preview; other former contents
                  are not recreated.
                </p>
                <div className="mt-4">
                  <ActivityTimeline
                    events={historyQuery.data?.items ?? []}
                    emptyText="No moves or lending history yet. Legacy items do not have fabricated history."
                    onChanged={() => {
                      void historyQuery.refetch();
                      void loansQuery.refetch();
                    }}
                  />
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {item.import_source && (
        <div className="surface mt-4 flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Import source
            </p>
            <p className="mt-1 text-xs">
              {item.import_source.title}
              {item.import_source.source_path
                ? ` · ${item.import_source.source_path}`
                : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={item.import_source.url}>
              Open import
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      )}

      <LendLoanDialog
        open={lendOpen}
        onOpenChange={setLendOpen}
        itemId={item.id}
        itemName={item.name}
        available={available}
        onCreated={() => {
          void loansQuery.refetch();
          void historyQuery.refetch();
        }}
      />

      {returnLoan && (
        <ReturnLoanDialog
          open={Boolean(returnLoan)}
          onOpenChange={(open) => {
            if (!open) setReturnLoan(null);
          }}
          loan={returnLoan}
          onReturned={() => {
            setReturnLoan(null);
            void loansQuery.refetch();
            void historyQuery.refetch();
          }}
        />
      )}

      <ItemDispositionDialog
        open={dispositionOpen}
        onOpenChange={setDispositionOpen}
        item={item}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${item.name}?`}
        description="The item and its photographs will be permanently removed. Documents used only by this item are removed too. A storage-bearing item must have its contents moved out and storage capability removed first."
        confirmLabel="Delete item"
        onConfirm={async () => {
          await remove.mutateAsync(item.id);
        }}
      />
    </div>
  );
}
