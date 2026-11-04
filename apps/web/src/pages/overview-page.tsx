import {
  DoorOpen,
  Download,
  FileText,
  HandCoins,
  Package,
  Plus,
  ReceiptText,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";

import { AddItemsButton, useAddItems } from "@/components/add-items";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { RoomCard } from "@/components/room-card";
import { QuickSearch } from "@/components/quick-search";
import { RoomDialog } from "@/components/room-dialog";
import { SectionHeading } from "@/components/section-heading";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WARRANTY_STATUS_LABELS,
  WARRANTY_STATUS_TONE,
  warrantyRemainingLabel,
} from "@/lib/labels";
import {
  useCanWrite,
  useFinancialOverview,
  useOverview,
  useRooms,
  useSession,
} from "@/lib/queries";
import type { FinancialOverview, Warranty, WarrantyStatus } from "@/lib/types";
import {
  buildRoomTree,
  formatCurrency,
  formatDate,
  greetingForHour,
  pluralize,
  roomDescendantsWithDepth,
} from "@/lib/utils";

export function OverviewPage() {
  const session = useSession();
  const overview = useOverview();
  const financialQuery = useFinancialOverview();
  const roomsQuery = useRooms();
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const { openAddItems } = useAddItems();
  const canWrite = useCanWrite();

  if (overview.isPending) return <OverviewSkeleton />;
  if (overview.isError) {
    return (
      <ErrorState
        title="Your home is out of reach"
        message="We couldn't load your overview just now."
        onRetry={() => void overview.refetch()}
      />
    );
  }

  const data = overview.data;
  const rooms = roomsQuery.data?.items ?? [];
  const rootRooms = buildRoomTree(rooms);
  const user = session.data?.user;
  const firstName = user?.name.trim().split(/\s+/)[0] ?? "there";
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  const purchaseValue = data.value_by_currency[0];
  const currentValue = data.current_value_by_currency[0];
  const purchaseLabel = purchaseValue
    ? formatCurrency(purchaseValue.total_cents, purchaseValue.currency, { compact: true })
    : "—";
  const currentLabel = currentValue
    ? formatCurrency(currentValue.total_cents, currentValue.currency, { compact: true })
    : "—";
  const warrantyCounts = data.warranties;
  const hasWarranties =
    warrantyCounts.active_count +
      warrantyCounts.expiring_count +
      warrantyCounts.expired_count +
      warrantyCounts.unknown_count >
    0;

  return (
    <div className="animate-fade-up">
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-3">{today}</p>
          <h1 className="display-title">
            {greetingForHour(new Date().getHours())}, {firstName}.
          </h1>
          <p className="mt-3 max-w-2xl text-pretty text-[0.94rem] leading-relaxed text-muted-foreground">
            {data.item_count === 0
              ? "A calm record of everything you own — where it lives, what it cost, what it is worth, and the paperwork that proves it."
              : `${pluralize(data.item_count, "item")} across ${pluralize(data.room_count, "room")}, with ${pluralize(data.document_count, "document")} in the library. Everything has a place.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="outline" onClick={() => setRoomDialogOpen(true)}>
            <DoorOpen />
            New room
          </Button>
          <AddItemsButton />
        </div>
      </header>

      <div className="mb-6 lg:hidden">
        <QuickSearch variant="mobile" />
      </div>

      <div className="grid grid-cols-2 gap-3.5 sm:gap-4 xl:grid-cols-5">
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
        <StatCard
          label="Purchase value"
          value={
            <span>
              {purchaseLabel}
              {data.value_by_currency.length > 1 && (
                <span className="ml-1.5 align-middle font-sans text-base font-medium text-muted-foreground">
                  +{data.value_by_currency.length - 1}
                </span>
              )}
            </span>
          }
          detail={
            data.value_by_currency.length > 1
              ? `${data.value_by_currency.length} currencies, reported separately`
              : purchaseValue
                ? "Recorded purchase value"
                : "No purchase prices yet"
          }
          icon={Wallet}
          to="/purchases"
        />
        <StatCard
          label="Current value"
          value={
            <span>
              {currentLabel}
              {data.current_value_by_currency.length > 1 && (
                <span className="ml-1.5 align-middle font-sans text-base font-medium text-muted-foreground">
                  +{data.current_value_by_currency.length - 1}
                </span>
              )}
            </span>
          }
          detail={
            currentValue ? "Your estimates, kept separate" : "No current values yet"
          }
          icon={TrendingUp}
          to="/items"
        />
        <StatCard
          label="Warranties"
          value={warrantyCounts.expiring_count}
          detail={`${warrantyCounts.active_count} active · ${warrantyCounts.expired_count} expired`}
          icon={ShieldCheck}
          to="/warranties"
        />
      </div>

      {data.outstanding_loan_count > 0 && (
        <Link
          to="/loans"
          className="surface mt-4 flex flex-col gap-2 border-brass/25 bg-brass-soft/25 px-4 py-3.5 transition-colors hover:bg-brass-soft/40 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2.5 text-[0.8rem] leading-relaxed">
            <HandCoins className="mt-0.5 size-4 shrink-0 text-brass" />
            <span>
              <strong className="font-medium">
                {data.on_loan_quantity} {data.on_loan_quantity === 1 ? "unit" : "units"}
              </strong>{" "}
              on loan across {pluralize(data.outstanding_loan_count, "open loan")}.
              Owned totals still include them.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[0.72rem] text-muted-foreground">
            {data.overdue_loan_count > 0 && (
              <Badge variant="brass">{data.overdue_loan_count} past due</Badge>
            )}
            <span className="underline underline-offset-4">View loans</span>
          </span>
        </Link>
      )}

      <OwnershipSection financial={financialQuery.data} loading={financialQuery.isPending} />

      <section className="mt-10">
        <SectionHeading
          title="Warranty watch"
          description={
            hasWarranties
              ? `Expiring-soon reminders use a ${pluralize(warrantyCounts.reminder_days, "day")} window.`
              : "Add a warranty to an item to see expirations here."
          }
          actionLabel={hasWarranties ? "All warranties" : undefined}
          actionTo={hasWarranties ? "/warranties" : undefined}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <WarrantyGroup
            title="Expiring soon"
            status="expiring"
            warranties={warrantyCounts.expiring_soon}
            total={warrantyCounts.expiring_count}
          />
          <WarrantyGroup
            title="Active"
            status="active"
            warranties={warrantyCounts.active}
            total={warrantyCounts.active_count}
          />
          <WarrantyGroup
            title="Expired"
            status="expired"
            warranties={warrantyCounts.expired}
            total={warrantyCounts.expired_count}
          />
        </div>
      </section>

      {data.item_count === 0 ? (
        <div className="mt-9">
          <EmptyState
            title="Your home, ready for its first story."
            description={
              canWrite
                ? "Add something you own — a camera, a favourite pan, the keys by the door. Then give it a room, an exact place, and a paper trail."
                : "This household does not have any inventory items yet."
            }
            actionLabel={canWrite ? "Add items" : undefined}
            onAction={canWrite ? () => openAddItems() : undefined}
            secondary={
              canWrite ? (
                <Button variant="ghost" onClick={() => setRoomDialogOpen(true)}>
                  {rootRooms.length > 0 ? "Add another room" : "Add a room first"}
                </Button>
              ) : undefined
            }
          />
          {rootRooms.length > 0 && (
            <section className="mt-10">
              <SectionHeading
                title="Your rooms"
                description="Rooms you have started. Add something to them when you're ready."
                actionLabel="All rooms"
                actionTo="/rooms"
              />
              <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rootRooms.map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    nestedRooms={roomDescendantsWithDepth(rooms, room.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="mt-10 grid items-start gap-9 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <section>
            <SectionHeading
              title="Recently added"
              description="The latest additions to your collection."
              actionLabel="All items"
              actionTo="/items"
            />
            {data.recent_items.length > 0 ? (
              <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
                {data.recent_items.slice(0, 6).map((item) => (
                  <ItemCard key={item.id} item={item} />
                ))}
              </div>
            ) : (
              <div className="surface px-5 py-10 text-center text-sm text-muted-foreground">
                Nothing added yet.
              </div>
            )}
          </section>

          <aside className="space-y-5">
            <SectionHeading
              title="Your rooms"
              description="Browse by where things live."
              actionLabel={rooms.length > 0 ? "All rooms" : undefined}
              actionTo={rooms.length > 0 ? "/rooms" : undefined}
            />
            {rootRooms.length > 0 ? (
              <div className="stagger space-y-3.5">
                {rootRooms.slice(0, 4).map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    nestedRooms={roomDescendantsWithDepth(rooms, room.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="surface p-6">
                <p className="font-display text-xl tracking-[-0.02em]">Give things a place.</p>
                <p className="mt-2 text-[0.82rem] leading-relaxed text-muted-foreground">
                  Rooms and shelves make everything easier to find — and easier to put
                  away.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-5"
                  onClick={() => setRoomDialogOpen(true)}
                >
                  <Plus />
                  Add a room
                </Button>
              </div>
            )}
          </aside>
        </div>
      )}

      <RoomDialog
        open={roomDialogOpen}
        onOpenChange={setRoomDialogOpen}
        rooms={rooms}
      />
    </div>
  );
}

function OwnershipSection({
  financial,
  loading,
}: {
  financial: FinancialOverview | undefined;
  loading: boolean;
}) {
  return (
    <section className="mt-10">
      <SectionHeading
        title="Ownership value"
        description="Purchase totals and current estimates are reported side by side, never added across currencies."
        actionLabel="Purchases"
        actionTo="/purchases"
      />
      {loading || !financial ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      ) : financial.item_count === 0 ? (
        <div className="surface p-6 text-[0.82rem] text-muted-foreground">
          Add items and purchase details to see ownership value here.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {financial.currency_totals.length === 0 ? (
              <div className="surface p-6 text-[0.82rem] leading-relaxed text-muted-foreground lg:col-span-2">
                No purchase or current values recorded yet. Add them while editing an
                item, or import a receipt through Documents.
              </div>
            ) : (
              financial.currency_totals.slice(0, 2).map((entry) => (
                <div key={entry.currency} className="surface p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                      {entry.currency}
                    </p>
                    <Badge variant="outline">{pluralize(entry.purchase_item_count, "priced item")}</Badge>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                        Purchase
                      </p>
                      <p className="mt-1 font-display text-[1.55rem] leading-none tracking-[-0.03em] tabular-nums">
                        {formatCurrency(entry.purchase_total_cents, entry.currency, {
                          compact: true,
                        })}
                      </p>
                    </div>
                    <div>
                      <p className="text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                        Current estimate
                      </p>
                      <p className="mt-1 font-display text-[1.55rem] leading-none tracking-[-0.03em] tabular-nums">
                        {formatCurrency(entry.current_value_cents, entry.currency, {
                          compact: true,
                        })}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-[0.68rem] leading-relaxed text-muted-foreground">
                    {entry.purchase_item_count} items with purchase data ·{" "}
                    {entry.current_value_item_count} items with estimates. Values are not
                    converted between currencies.
                  </p>
                </div>
              ))
            )}
            <div className="surface p-5">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" strokeWidth={1.7} />
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Missing purchase info
                </p>
              </div>
              <p className="mt-5 font-display text-[2rem] leading-none tracking-[-0.03em] tabular-nums">
                {financial.items_missing_purchase_count}
              </p>
              <p className="mt-2 text-[0.72rem] leading-relaxed text-muted-foreground">
                Items without both a purchase date and a price.{" "}
                {financial.missing_purchase_items.length > 0
                  ? "Start with the list below."
                  : "Everything has a basic purchase record."}
              </p>
              {financial.missing_purchase_items.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {financial.missing_purchase_items.slice(0, 3).map((item) => (
                    <Link key={item.id} to={`/items/${item.id}/edit`}>
                      <Badge variant="secondary" className="hover:bg-secondary/70">
                        {item.name}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
              <Button variant="outline" size="sm" className="mt-4" asChild>
                <a href="/api/v1/exports/inventory.csv">
                  <Download />
                  Inventory CSV
                </a>
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownTable title="Value by category" rows={financial.value_by_category} />
            <BreakdownTable title="Value by room" rows={financial.value_by_room} />
          </div>

          {financial.most_valuable_items.length > 0 && (
            <div className="surface p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-[1.2rem] tracking-[-0.02em]">
                    Most valuable items
                  </h3>
                  <p className="mt-1 text-[0.72rem] text-muted-foreground">
                    Current estimate where recorded, otherwise the allocated purchase
                    value.
                  </p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/items">All items</Link>
                </Button>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {financial.most_valuable_items.slice(0, 6).map((entry) => (
                  <Link
                    key={entry.item.id}
                    to={`/items/${entry.item.id}`}
                    className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 transition-colors hover:bg-secondary/40"
                  >
                    {entry.item.primary_photo ? (
                      <img
                        src={entry.item.primary_photo.thumbnail_url}
                        alt=""
                        loading="lazy"
                        className="size-10 shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground/60">
                        <Package className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8rem] font-medium">
                        {entry.item.name}
                      </span>
                      <span className="block truncate text-[0.68rem] text-muted-foreground">
                        {entry.item.room?.name ?? "No room"} ·{" "}
                        {entry.value_kind === "current" ? "current estimate" : "purchase share"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[0.8rem] font-medium tabular-nums">
                      {formatCurrency(entry.value_cents, entry.currency, { compact: true })}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: FinancialOverview["value_by_category"];
}) {
  return (
    <div className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
        <h3 className="font-display text-[1.2rem] tracking-[-0.02em]">{title}</h3>
        <ReceiptText className="size-4 text-muted-foreground" strokeWidth={1.7} />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-[0.78rem] text-muted-foreground">
          No values recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-[0.76rem]">
            <thead>
              <tr className="border-b border-border/60 text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 text-right font-medium">Purchase</th>
                <th className="px-5 py-2.5 text-right font-medium">Current</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((row) => (
                <tr key={`${row.name}-${row.currency}`} className="border-b border-border/40 last:border-0">
                  <td className="px-5 py-2.5">
                    <span className="block max-w-40 truncate">{row.name}</span>
                    <span className="text-[0.65rem] text-muted-foreground">
                      {pluralize(row.item_count, "item")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{row.currency}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatCurrency(row.purchase_total_cents, row.currency, { compact: true })}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {formatCurrency(row.current_value_cents, row.currency, { compact: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WarrantyGroup({
  title,
  status,
  warranties,
  total,
}: {
  title: string;
  status: WarrantyStatus;
  warranties: Warranty[];
  total: number;
}) {
  return (
    <div className="surface flex flex-col p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={WARRANTY_STATUS_TONE[status]}>{title}</Badge>
          <span className="text-[0.72rem] tabular-nums text-muted-foreground">{total}</span>
        </div>
        {total > 0 && (
          <Link
            to={`/warranties?status=${status}`}
            className="text-[0.68rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View all
          </Link>
        )}
      </div>
      <div className="mt-3 flex-1 space-y-1.5">
        {warranties.length === 0 ? (
          <p className="py-5 text-center text-[0.74rem] text-muted-foreground">
            Nothing here.
          </p>
        ) : (
          warranties.map((warranty) => (
            <Link
              key={warranty.id}
              to={warranty.item ? `/items/${warranty.item.id}` : "/warranties"}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-secondary/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.78rem] font-medium">
                  {warranty.item?.name ?? "Warranty"}
                </span>
                <span className="block truncate text-[0.66rem] text-muted-foreground">
                  {warranty.provider || "Provider not set"}
                  {warranty.end_date ? ` · ${formatDate(warranty.end_date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-[0.66rem] text-muted-foreground">
                {warrantyRemainingLabel(warranty.days_remaining, warranty.status)}
              </span>
            </Link>
          ))
        )}
      </div>
      {status === "expiring" && total > 0 && (
        <p className="mt-3 border-t border-border/50 pt-3 text-[0.66rem] leading-relaxed text-muted-foreground">
          {WARRANTY_STATUS_LABELS[status]} within the configured reminder window.
        </p>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="animate-pulse">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-5 h-12 w-2/3 max-w-md" />
      <div className="mt-10 grid grid-cols-2 gap-4 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-40 rounded-2xl" />
        ))}
      </div>
      <div className="mt-10 grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
      <div className="mt-10">
        <Skeleton className="h-6 w-44" />
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-52 rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
