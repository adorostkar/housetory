import { Plus } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
import { RoomCard } from "@/components/room-card";
import { RoomDialog } from "@/components/room-dialog";
import { Button } from "@/components/ui/button";
import { usePropertyFilter } from "@/hooks/use-property-filter";
import { useCanWrite, useRooms } from "@/lib/queries";
import { Select } from "@/components/ui/select";
import { buildRoomTree, pluralize, roomDescendantsWithDepth } from "@/lib/utils";

export function RoomsPage() {
  const { propertyId, setPropertyId, properties } = usePropertyFilter();
  const roomsQuery = useRooms(propertyId || undefined);
  const canWrite = useCanWrite();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (roomsQuery.isPending) return <PageSkeleton variant="cards" />;
  if (roomsQuery.isError) {
    return (
      <ErrorState
        title="Rooms are out of reach"
        message="We couldn't load the rooms in your home."
        onRetry={() => void roomsQuery.refetch()}
      />
    );
  }

  const rooms = roomsQuery.data.items;
  const groups = properties
    .filter((property) => !propertyId || property.id === propertyId)
    .map((property) => {
      const propertyRooms = rooms.filter((room) => room.property_id === property.id);
      return {
        property,
        roots: buildRoomTree(propertyRooms),
        rooms: propertyRooms,
      };
    })
    .filter((group) => group.rooms.length > 0);
  const ungrouped = rooms.filter(
    (room) => !properties.some((property) => property.id === room.property_id),
  );

  return (
    <PageLayout
      header={{
        eyebrow: "Your home",
        title: "Rooms",
        description:
          rooms.length > 0
            ? `${pluralize(rooms.length, "room")}, each with its own places to keep things.`
            : "The rooms and corners that make up your home.",
        actions: (
          <>
            <Select
              aria-label="Filter rooms by property"
              value={propertyId}
              onChange={(event) => setPropertyId(event.target.value)}
              className="w-auto min-w-[170px]"
            >
              <option value="">All properties</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
            {canWrite ? (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus />
                Add a room
              </Button>
            ) : null}
          </>
        ),
      }}
    >
      {groups.length === 0 ? (
        <EmptyState
          title="No rooms yet."
          description={
            canWrite
              ? "Kitchen, bedroom, garage, a single shelf by the door. Rooms are the first layer of finding everything again."
              : "This household does not have any rooms yet."
          }
          actionLabel={canWrite ? "Add your first room" : undefined}
          onAction={canWrite ? () => setDialogOpen(true) : undefined}
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.property.id}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-[1.2rem] tracking-[-0.02em]">
                    {group.property.name}
                  </h2>
                  <p className="text-2xs text-muted-foreground">
                    {pluralize(group.rooms.length, "room")} ·{" "}
                    {pluralize(group.property.total_quantity, "unit")}
                    {group.property.is_archived ? " · archived" : ""}
                  </p>
                </div>
              </div>
              <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.roots.map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    nestedRooms={roomDescendantsWithDepth(group.rooms, room.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {properties.length === 0 && ungrouped.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-[1.2rem] tracking-[-0.02em]">
                No property
              </h2>
              <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {buildRoomTree(ungrouped).map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    nestedRooms={roomDescendantsWithDepth(ungrouped, room.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <RoomDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rooms={rooms}
        defaultPropertyId={propertyId || undefined}
      />
    </PageLayout>
  );
}
