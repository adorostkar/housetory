import { Plus } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { RoomCard } from "@/components/room-card";
import { RoomDialog } from "@/components/room-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRooms } from "@/lib/queries";
import { buildRoomTree, pluralize, roomDescendantsWithDepth } from "@/lib/utils";

export function RoomsPage() {
  const roomsQuery = useRooms();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (roomsQuery.isPending) return <RoomsSkeleton />;
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
  const roots = buildRoomTree(rooms);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Your home"
        title="Rooms"
        description={
          rooms.length > 0
            ? `${pluralize(rooms.length, "room")}, each with its own places to keep things.`
            : "The rooms and corners that make up your home."
        }
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus />
            Add a room
          </Button>
        }
      />

      {roots.length === 0 ? (
        <EmptyState
          title="Begin with a room."
          description="Kitchen, bedroom, garage, a single shelf by the door. Rooms are the first layer of finding everything again."
          actionLabel="Add your first room"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {roots.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              nestedRooms={roomDescendantsWithDepth(rooms, room.id)}
            />
          ))}
        </div>
      )}

      <RoomDialog open={dialogOpen} onOpenChange={setDialogOpen} rooms={rooms} />
    </div>
  );
}

function RoomsSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-11 w-48" />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-52 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
