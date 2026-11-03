import {
  Armchair,
  Bath,
  BedDouble,
  Car,
  ChevronRight,
  CookingPot,
  DoorOpen,
  Dumbbell,
  Leaf,
  Monitor,
  Package,
  Shirt,
  Utensils,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { cn, pluralize } from "@/lib/utils";
import type { Room } from "@/lib/types";

const iconMap: Array<{ test: RegExp; icon: LucideIcon }> = [
  { test: /kitchen|cook|pantry/i, icon: CookingPot },
  { test: /bed|primary|guest/i, icon: BedDouble },
  { test: /bath|wash/i, icon: Bath },
  { test: /living|lounge|den|family/i, icon: Armchair },
  { test: /office|study|studio/i, icon: Monitor },
  { test: /garage|car|parking/i, icon: Car },
  { test: /closet|wardrobe|dress/i, icon: Shirt },
  { test: /gym|workout|fitness/i, icon: Dumbbell },
  { test: /garden|balcony|patio|yard/i, icon: Leaf },
  { test: /dining/i, icon: Utensils },
];

export function roomIcon(name: string): LucideIcon {
  return iconMap.find((entry) => entry.test.test(name))?.icon ?? DoorOpen;
}

export function RoomCard({
  room,
  childRooms = [],
  className,
}: {
  room: Room;
  childRooms?: Room[];
  className?: string;
}) {
  const Icon = roomIcon(room.name);
  return (
    <div
      className={cn(
        "surface group relative overflow-hidden transition-[border-color,box-shadow] duration-300 hover:border-border hover:shadow-lift",
        className,
      )}
    >
      <Link
        to={`/rooms/${room.id}`}
        className="flex flex-col p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-secondary/85 text-foreground/65">
            <Icon className="size-[1.2rem]" strokeWidth={1.6} />
          </span>
          <ChevronRight className="mt-1 size-4 text-muted-foreground/60 transition-transform duration-300 group-hover:translate-x-0.5" />
        </div>
        <h3 className="mt-5 font-display text-[1.5rem] font-normal leading-tight tracking-[-0.02em]">
          {room.name}
        </h3>
        <p className="mt-1.5 text-[0.78rem] text-muted-foreground">
          {pluralize(room.item_count, "item")}
          {room.location_count > 0 && ` · ${pluralize(room.location_count, "place")}`}
        </p>
        {room.description && (
          <p className="mt-3 line-clamp-2 text-[0.8rem] leading-relaxed text-muted-foreground/90">
            {room.description}
          </p>
        )}
      </Link>

      {childRooms.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          {childRooms.map((child) => (
            <Link
              key={child.id}
              to={`/rooms/${child.id}`}
              className="flex items-center justify-between rounded-lg px-2.5 py-2 text-[0.78rem] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-border" />
                <span className="truncate">{child.name}</span>
              </span>
              <span className="shrink-0 text-[0.68rem] tabular-nums">{child.item_count}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoomIcon({ name, className }: { name: string; className?: string }) {
  const Icon = roomIcon(name);
  return <Icon className={className} strokeWidth={1.6} />;
}

export function LocationIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon =
    kind === "drawer"
      ? Package
      : kind === "cabinet" || kind === "shelf" || kind === "closet"
        ? DoorOpen
        : Package;
  return <Icon className={className} strokeWidth={1.6} />;
}
