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
  { test: /\b(living|lounge|den|family)\b/i, icon: Armchair },
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
  nestedRooms = [],
  className,
}: {
  room: Room;
  nestedRooms?: Array<{ room: Room; depth: number }>;
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
        className="flex items-center gap-3.5 p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:flex-col sm:items-stretch sm:gap-0 sm:p-6"
      >
        <div className="contents sm:flex sm:items-start sm:justify-between sm:gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary/85 text-foreground/65 sm:size-11">
            <Icon className="size-[1.2rem]" strokeWidth={1.6} />
          </span>
          <ChevronRight className="order-last ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-hover:translate-x-0.5 sm:order-none sm:ml-0 sm:mt-1" />
        </div>
        <div className="min-w-0 flex-1 sm:flex-none">
          <h3 className="truncate font-display text-[1.25rem] font-normal leading-tight tracking-[-0.02em] sm:mt-5 sm:text-[1.5rem]">
            {room.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1.5">
            {pluralize(room.total_item_count, "item")}
            {room.total_location_count > 0 && ` · ${pluralize(room.total_location_count, "place")}`}
          </p>
          {room.description && (
            <p className="mt-3 hidden line-clamp-2 text-xs leading-relaxed text-muted-foreground sm:block">
              {room.description}
            </p>
          )}
        </div>
      </Link>

      {nestedRooms.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          {nestedRooms.map(({ room: child, depth }) => (
            <Link
              key={child.id}
              to={`/rooms/${child.id}`}
              className="flex items-center justify-between rounded-lg px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              style={{
                marginLeft: `${depth * 18}px`,
                paddingLeft: "10px",
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-border" />
                <span className="truncate">{child.name}</span>
              </span>
              <span className="shrink-0 text-2xs tabular-nums">
                {child.total_item_count}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
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
