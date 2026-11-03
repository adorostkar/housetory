import { DoorOpen, Package, Plus, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { RoomCard } from "@/components/room-card";
import { RoomDialog } from "@/components/room-dialog";
import { SectionHeading } from "@/components/section-heading";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOverview, useRooms, useSession } from "@/lib/queries";
import { buildRoomTree, formatCurrency, greetingForHour, pluralize } from "@/lib/utils";

export function OverviewPage() {
  const session = useSession();
  const overview = useOverview();
  const roomsQuery = useRooms();
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);

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

  const primaryValue = data.value_by_currency[0];
  const valueLabel = primaryValue
    ? formatCurrency(primaryValue.total_cents, primaryValue.currency, { compact: true })
    : "—";
  const valueDetail =
    data.value_by_currency.length > 1
      ? `${data.value_by_currency.length} currencies recorded`
      : primaryValue
        ? "Recorded purchase value"
        : "No purchase prices yet";

  return (
    <div className="animate-fade-up">
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-3">{today}</p>
          <h1 className="display-title">
            {greetingForHour(new Date().getHours())}, {firstName}.
          </h1>
          <p className="mt-3 max-w-xl text-pretty text-[0.94rem] leading-relaxed text-muted-foreground">
            {data.item_count === 0
              ? "A calm home for everything you own. Begin with a room, then give the things inside it a place."
              : `${pluralize(data.item_count, "item")} across ${pluralize(data.room_count, "room")}. Everything has a place.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="outline" onClick={() => setRoomDialogOpen(true)}>
            <DoorOpen />
            New room
          </Button>
          <Button asChild>
            <Link to="/items/new">
              <Plus />
              Add an item
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3.5 sm:gap-4 xl:grid-cols-4">
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
          detail={`${pluralize(data.location_count, "storage place")}`}
          icon={DoorOpen}
          to="/rooms"
        />
        <StatCard
          label="Value"
          value={
            <span>
              {valueLabel}
              {data.value_by_currency.length > 1 && (
                <span className="ml-1.5 align-middle font-sans text-base font-medium text-muted-foreground">
                  +{data.value_by_currency.length - 1}
                </span>
              )}
            </span>
          }
          detail={valueDetail}
          icon={Wallet}
        />
        <StatCard
          label="Warranties"
          value={data.warranties_expiring_soon}
          detail="Ending in the next 30 days"
          icon={ShieldCheck}
        />
      </div>

      {data.item_count === 0 ? (
        <div className="mt-9">
          <EmptyState
            title="Your home, ready for its first story."
            description="Add something you own — a camera, a favourite pan, the keys by the door. Then give it a room and an exact place."
            actionLabel="Add your first item"
            actionTo="/items/new"
            secondary={
              <Button variant="ghost" onClick={() => setRoomDialogOpen(true)}>
                {rootRooms.length > 0 ? "Add another room" : "Add a room first"}
              </Button>
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
                  <RoomCard key={room.id} room={room} childRooms={room.children} />
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
                  <RoomCard key={room.id} room={room} childRooms={room.children} />
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

function OverviewSkeleton() {
  return (
    <div className="animate-pulse">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="mt-5 h-12 w-2/3 max-w-md" />
      <div className="mt-10 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-40 rounded-2xl" />
        ))}
      </div>
      <div className="mt-10 grid gap-9 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div>
          <Skeleton className="h-6 w-44" />
          <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-64 rounded-2xl" />
            ))}
          </div>
        </div>
        <div>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="mt-5 h-36 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
