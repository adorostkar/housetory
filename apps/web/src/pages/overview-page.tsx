import {
  DoorOpen,
  Download,
  FileText,
  HandCoins,
  Package,
  Plus,
  ReceiptText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";

import { AddItemsButton, useAddItems } from "@/components/add-items";
import { FirstRunChecklist } from "@/components/first-run-checklist";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { ItemCard, ItemRow } from "@/components/item-card";
import { useItemsView, ViewToggle } from "@/components/view-toggle";
import { RoomCard } from "@/components/room-card";
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
  const [recentView, setRecentView] = useItemsView(() =>
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches
      ? "list"
      : "grid",
  );
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
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
  const purchaseLabel = purchaseValue
    ? formatCurrency(purchaseValue.total_cents, purchaseValue.currency, { compact: true })
    : "—";
  const warrantyCounts = data.warranties;
  const hasWarranties =
    warrantyCounts.active_count +
      warrantyCounts.expiring_count +
      warrantyCounts.expired_count +
      warrantyCounts.unknown_count >
    0;
  const hasPurchaseValues = data.value_by_currency.length > 0;
  const statCount = 2 + (hasPurchaseValues ? 1 : 0) + (hasWarranties ? 1 : 0);
  const statGridClass =
    statCount >= 5
      ? "xl:grid-cols-5"
      : statCount === 4
        ? "xl:grid-cols-4"
        : "xl:grid-cols-3";

  return (
    <div className="animate-fade-up">
      <header className="mb-6 flex flex-col gap-4 sm:mb-10 sm:gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-3 hidden sm:block">{today}</p>
          <h1 className="display-title">
            {greetingForHour(new Date().getHours())}, {firstName}.
          </h1>
          {data.item_count === 0 ? (
            <p className="mt-2 max-w-2xl text-pretty text-[0.94rem] leading-relaxed text-muted-foreground sm:mt-3">
              A calm record of everything you own — where it lives, what it cost, and the paperwork that proves it.
            </p>
          ) : (
            warrantyCounts.expiring_count > 0 && (
              <p className="mt-2 text-[0.94rem] text-muted-foreground sm:mt-3">
                <Link
                  to="/warranties"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {pluralize(warrantyCounts.expiring_count, "warranty")} expiring soon
                </Link>
              </p>
            )
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {data.item_count > 0 && (
            <>
              <Button variant="outline" asChild>
                <Link to="/insurance">
                  <ShieldCheck />
                  Create insurance list
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setEvidenceOpen(true)}>
                <Download />
                Export evidence
              </Button>
            </>
          )}
          <Button variant="outline" onClick={() => setRoomDialogOpen(true)}>
            <DoorOpen />
            New room
          </Button>
          <AddItemsButton className="hidden lg:inline-flex" />
        </div>
      </header>

      <div
        className={`grid grid-cols-2 gap-3.5 sm:gap-4 ${statGridClass}`}
      >
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
        {hasPurchaseValues && (
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
                : "Recorded purchase value"
            }
            icon={Wallet}
            to="/purchases"
          />
        )}
        {hasWarranties && (
          <StatCard
            label="Warranties"
            value={warrantyCounts.expiring_count}
            detail={`${warrantyCounts.active_count} active · ${warrantyCounts.expired_count} expired`}
            icon={ShieldCheck}
            to="/warranties"
          />
        )}
      </div>

      {data.outstanding_loan_count > 0 && (
        <Link
          to="/loans"
          className="surface mt-4 flex flex-col gap-2 border-brass/25 bg-brass-soft/25 px-4 py-3.5 transition-colors hover:bg-brass-soft/40 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2.5 text-xs leading-relaxed">
            <HandCoins className="mt-0.5 size-4 shrink-0 text-brass" />
            <span>
              <strong className="font-medium">
                {data.on_loan_quantity} {data.on_loan_quantity === 1 ? "unit" : "units"}
              </strong>{" "}
              on loan across {pluralize(data.outstanding_loan_count, "open loan")}.
              Owned totals still include them.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
            {data.overdue_loan_count > 0 && (
              <Badge variant="brass">{data.overdue_loan_count} past due</Badge>
            )}
            <span className="underline underline-offset-4">View loans</span>
          </span>
        </Link>
      )}

      {data.item_count === 0 ? (
        <div className="mt-9">
          {canWrite ? (
            <FirstRunChecklist
              roomCount={data.room_count}
              itemCount={data.item_count}
              documentCount={data.document_count}
              onCreateRoom={() => setRoomDialogOpen(true)}
              onAddItems={() => openAddItems()}
            />
          ) : (
            <EmptyState
              title="Your home, ready for its first story."
              description="This household does not have any inventory items yet."
            />
          )}
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
              extra={<ViewToggle view={recentView} onChange={setRecentView} />}
            />
            {data.recent_items.length > 0 ? (
              recentView === "list" ? (
                <div className="surface divide-y divide-border/60 overflow-hidden p-1.5">
                  {data.recent_items.slice(0, 5).map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                <div className="stagger grid grid-cols-2 gap-3.5 sm:gap-4 lg:grid-cols-3">
                  {data.recent_items.slice(0, 6).map((item) => (
                    <ItemCard key={item.id} item={item} />
                  ))}
                </div>
              )
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
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
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

      {data.item_count > 0 && (
        <>
          <OwnershipSection
            financial={financialQuery.data}
            loading={financialQuery.isPending}
          />

          <section className="mt-8">
            <SectionHeading
              title="Warranty watch"
              description={
                hasWarranties
                  ? `Expiring-soon reminders use a ${pluralize(warrantyCounts.reminder_days, "day")} window.`
                  : "No warranties recorded. Add one while editing an item."
              }
              actionLabel={hasWarranties ? "All warranties" : undefined}
              actionTo={hasWarranties ? "/warranties" : undefined}
            />
            {hasWarranties ? (
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
            ) : (
              <div className="surface px-5 py-4 text-xs leading-relaxed text-muted-foreground">
                Warranty dates and documents stay with each item when you add them.
                Nothing is tracked as expiring yet.
              </div>
            )}
          </section>
        </>
      )}

      <RoomDialog
        open={roomDialogOpen}
        onOpenChange={setRoomDialogOpen}
        rooms={rooms}
      />
      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ include_home: true }}
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
  const hasValues = Boolean(
    financial &&
      (financial.currency_totals.length > 0 ||
        financial.value_by_category.length > 0 ||
        financial.value_by_room.length > 0),
  );

  return (
    <section className="mt-10">
      <SectionHeading
        title="Purchases"
        description="Historical purchase transaction totals, kept separate by currency."
        actionLabel="Purchases"
        actionTo="/purchases"
      />
      {loading || !financial ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : !hasValues ? (
        <div className="surface flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground/85">No purchase values yet.</p>
            <p className="mt-1">
              {financial.items_missing_purchase_count > 0
                ? `${financial.items_missing_purchase_count} items have missing or unresolved purchase information. Items marked not applicable are excluded.`
                : "Purchase details appear here when recorded."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {financial.items_missing_purchase_count > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/items?purchase_info=missing">Review missing</Link>
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link to="/purchases">Purchases</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {financial.currency_totals.slice(0, 2).map((entry) => (
              <div key={entry.currency} className="surface p-5">
                <div className="flex items-center justify-between">
                  <p className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                    {entry.currency}
                  </p>
                  <Badge variant="outline">
                    {pluralize(entry.purchase_item_count, "priced item")}
                  </Badge>
                </div>
                <div className="mt-5">
                  <p className="text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                    Purchase
                  </p>
                  <p className="mt-1 font-display text-[1.55rem] leading-none tracking-[-0.03em] tabular-nums">
                    {formatCurrency(entry.purchase_total_cents, entry.currency, {
                      compact: true,
                    })}
                  </p>
                </div>
                <p className="mt-4 text-2xs leading-relaxed text-muted-foreground">
                  {entry.purchase_item_count} items with purchase data. Values are not
                  converted between currencies.
                </p>
              </div>
            ))}
            <div className="surface p-5">
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" strokeWidth={1.7} />
                <p className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Missing purchase info
                </p>
              </div>
              <p className="mt-5 font-display text-[2rem] leading-none tracking-[-0.03em] tabular-nums">
                {financial.items_missing_purchase_count}
              </p>
              <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
                Items without recorded purchase details and not marked not applicable.
                Explicitly Unknown remains unresolved.
              </p>
              <Button variant="outline" size="sm" className="mt-4" asChild>
                <Link to="/items?purchase_info=missing">Review missing</Link>
              </Button>
              <a
                href="/api/v1/exports/inventory.csv"
                className="mt-3 inline-flex items-center gap-1.5 text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                <Download className="size-3.5" />
                Inventory CSV
              </a>
            </div>
          </div>

          {(financial.value_by_category.length > 0 ||
            financial.value_by_room.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {financial.value_by_category.length > 0 && (
                <BreakdownTable title="Purchases by category" rows={financial.value_by_category} />
              )}
              {financial.value_by_room.length > 0 && (
                <BreakdownTable title="Purchases by room" rows={financial.value_by_room} />
              )}
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
        <p className="px-5 py-8 text-center text-xs text-muted-foreground">
          No values recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 text-2xs uppercase tracking-[0.1em] text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-5 py-2.5 text-right font-medium">Purchase</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((row) => (
                <tr key={`${row.name}-${row.currency}`} className="border-b border-border/40 last:border-0">
                  <td className="px-5 py-2.5">
                    <span className="block max-w-40 truncate">{row.name}</span>
                    <span className="text-2xs text-muted-foreground">
                      {pluralize(row.item_count, "item")}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{row.currency}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {formatCurrency(row.purchase_total_cents, row.currency, { compact: true })}
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
          <span className="text-2xs tabular-nums text-muted-foreground">{total}</span>
        </div>
        {total > 0 && (
          <Link
            to={`/warranties?status=${status}`}
            className="text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View all
          </Link>
        )}
      </div>
      <div className="mt-3 flex-1 space-y-1.5">
        {warranties.length === 0 ? (
          <p className="py-5 text-center text-2xs text-muted-foreground">
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
                <span className="block truncate text-xs font-medium">
                  {warranty.item?.name ?? "Warranty"}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {warranty.provider || "Provider not set"}
                  {warranty.end_date ? ` · ${formatDate(warranty.end_date)}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {warrantyRemainingLabel(warranty.days_remaining, warranty.status)}
              </span>
            </Link>
          ))
        )}
      </div>
      {status === "expiring" && total > 0 && (
        <p className="mt-3 border-t border-border/50 pt-3 text-2xs leading-relaxed text-muted-foreground">
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
