import {
  Archive,
  Baby,
  Bath,
  BedDouble,
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  Car,
  Check,
  ChevronDown,
  ClipboardCheck,
  CookingPot,
  DoorClosed,
  DoorOpen,
  FileText,
  Hammer,
  ListChecks,
  Handshake,
  House,
  LayoutGrid,
  MapPin,
  Menu,
  Settings,
  ShieldCheck,
  Sofa,
  Trees,
  Utensils,
  Wallet,
  Warehouse,
  WashingMachine,
  X,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { isFinancialsPath } from "@/components/financials-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readOrigin } from "@/lib/navigation";
import { setStoredPropertyId, useStoredPropertyId } from "@/lib/property-filter-store";
import { useLoans, useProperties, useRooms } from "@/lib/queries";
import type { Room } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROOM_ICONS: Array<[RegExp, LucideIcon]> = [
  [/kitchen|kök|pantry/i, CookingPot],
  [/dining|matsal/i, Utensils],
  [/living|lounge|sitting|vardagsrum|family/i, Sofa],
  [/office|study|kontor|arbetsrum/i, BriefcaseBusiness],
  [/library|bibliotek/i, BookOpen],
  [/bed|sovrum|guest/i, BedDouble],
  [/bath|toilet|badrum|wc/i, Bath],
  [/laundry|utility|tvätt/i, WashingMachine],
  [/nursery|kids|child|barn/i, Baby],
  [/garage|carport/i, Warehouse],
  [/car\b|vehicle|bil\b/i, Car],
  [/workshop|tool|verkstad|hobby/i, Hammer],
  [/attic|loft|vind|basement|cellar|källare|storage|förråd/i, Boxes],
  [/closet|wardrobe|cupboard|garderob/i, Archive],
  [/garden|shed|yard|outdoor|balcon|patio|trädgård/i, Trees],
  [/hall|entr|corridor|lobby/i, DoorOpen],
];

export function roomIcon(name: string): LucideIcon {
  return ROOM_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? DoorClosed;
}

interface Destination {
  to: string;
  label: string;
  /** Short label for the narrow rail. */
  short: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
}

const under = (base: string) => (pathname: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/** Everything that is not a room. On the phone these roll up over the rooms. */
export const MORE_DESTINATIONS: Destination[] = [
  { to: "/loans", label: "Loans", short: "Loans", icon: Handshake, match: (path) => under("/loans")(path) || under("/borrowed")(path) },
  { to: "/rooms", label: "Places", short: "Places", icon: MapPin, match: (path) => path === "/rooms" || under("/containers")(path) || under("/labels")(path) },
  { to: "/documents", label: "Documents", short: "Docs", icon: FileText, match: under("/documents") },
  { to: "/purchases", label: "Purchases", short: "Buys", icon: Wallet, match: (path) => isFinancialsPath(path) && !under("/insurance")(path) },
  { to: "/insurance", label: "Insurance", short: "Insure", icon: ShieldCheck, match: under("/insurance") },
  { to: "/stocktake", label: "Stocktake", short: "Count", icon: ListChecks, match: under("/stocktake") },
  { to: "/review", label: "Review", short: "Review", icon: ClipboardCheck, match: under("/review") },
  { to: "/settings", label: "Settings", short: "Settings", icon: Settings, match: under("/settings") },
];

export interface RailModel {
  rooms: Room[];
  /** "all", "loans", "more:<path>", a room id, or null. */
  active: string | null;
  overdue: number;
  onLoan: number;
  properties: { id: string; name: string }[];
  propertyId: string;
  setPropertyId: (id: string) => void;
}

/** The rooms and the current place, shared by the phone rail and the desktop sidebar. */
export function useRailModel(): RailModel {
  const location = useLocation();
  const navigate = useNavigate();
  const storedPropertyId = useStoredPropertyId();
  const propertiesQuery = useProperties();
  const properties = React.useMemo(
    () => (propertiesQuery.data?.items ?? []).filter((property) => !property.is_archived),
    [propertiesQuery.data],
  );
  const propertyId = properties.some((property) => property.id === storedPropertyId)
    ? storedPropertyId
    : "";
  const roomsQuery = useRooms(propertyId || undefined);
  const loans = useLoans({}, 1);
  const allRooms = roomsQuery.data?.items;
  const rooms = React.useMemo(
    () => (allRooms ?? []).filter((room) => room.parent_id === null),
    [allRooms],
  );

  // An item opened from a room still belongs to that room in the rail.
  const origin = /^\/items\/[^/]+/.test(location.pathname)
    ? readOrigin(new URLSearchParams(location.search))?.path.split("?")[0]
    : undefined;
  const path = origin ?? location.pathname;
  let active: string | null = null;
  const roomMatch = path.match(/^\/rooms\/([^/]+)/);
  if (roomMatch) {
    // A nested room lights up its top-level room.
    let current = allRooms?.find((room) => room.id === roomMatch[1]);
    while (current?.parent_id) {
      const parent = allRooms?.find((room) => room.id === current?.parent_id);
      if (!parent) break;
      current = parent;
    }
    active = current?.id ?? roomMatch[1] ?? null;
  } else if (path === "/" || path === "/items" || path.startsWith("/items/")) {
    active = "all";
  } else {
    const destination = MORE_DESTINATIONS.find((entry) => entry.match(path));
    if (destination) active = destination.to === "/loans" ? "loans" : `more:${destination.to}`;
  }

  const setPropertyId = React.useCallback(
    (id: string) => {
      setStoredPropertyId(id);
      // The list pages read the property from their address too.
      if (["/items", "/rooms", "/containers"].includes(location.pathname)) {
        const next = new URLSearchParams(location.search);
        if (id) next.set("property_id", id);
        else next.delete("property_id");
        navigate(
          { pathname: location.pathname, search: next.size ? `?${next.toString()}` : "" },
          { replace: true },
        );
      }
    },
    [location.pathname, location.search, navigate],
  );

  return {
    rooms,
    active,
    overdue: loans.data?.overdue_count ?? 0,
    onLoan: loans.data?.outstanding_count ?? 0,
    properties,
    propertyId,
    setPropertyId,
  };
}

function PropertyMenu({
  model,
  children,
  side,
}: {
  model: RailModel;
  children: React.ReactNode;
  side: "right" | "bottom";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-56">
        <DropdownMenuLabel className="normal-case tracking-normal">Show rooms in</DropdownMenuLabel>
        {[{ id: "", name: "All properties" }, ...model.properties].map((property) => (
          <DropdownMenuItem
            key={property.id || "all"}
            className="min-h-11 gap-2.5"
            onSelect={() => model.setPropertyId(property.id)}
          >
            <span className="flex size-4 items-center justify-center">
              {property.id === model.propertyId && <Check className="size-3.5 text-sage" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{property.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type MoreState = "closed" | "open" | "closing";

function useMoreRoll(pathname: string, onMorePage: boolean) {
  const [state, setState] = React.useState<MoreState>("closed");
  // The choices stay up while one of them is open. Going to a room, an item or a
  // loan brings the rooms back.
  React.useEffect(() => {
    if (onMorePage) return;
    setState((current) => (current === "open" ? "closing" : current));
  }, [pathname, onMorePage]);
  return {
    state,
    toggle: () => setState((current) => (current === "open" ? "closing" : "open")),
    onAnimationEnd: () => setState((current) => (current === "closing" ? "closed" : current)),
  };
}

const tileClass = (active: boolean) =>
  cn(
    "relative flex min-h-[3.375rem] w-[3.625rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-center text-[0.65625rem] font-semibold leading-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
    active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
  );

function Tile({
  to,
  label,
  icon: Icon,
  active,
  badge,
  title,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
  title?: string;
}) {
  return (
    <Link to={to} aria-current={active ? "page" : undefined} title={title ?? label} className={tileClass(active)}>
      <Icon aria-hidden="true" className="size-[1.3rem]" strokeWidth={active ? 2.1 : 1.8} />
      <span className="line-clamp-2 max-w-full break-words">{label}</span>
      {badge ? (
        <span className="absolute right-1 top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-brass px-1 text-[0.625rem] font-semibold leading-none text-brass-foreground">
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> overdue</span>
        </span>
      ) : null}
    </Link>
  );
}

/** The phone rail: All, the rooms, On loan and More. It scrolls when there are many rooms. */
export function RoomRail({ model, className, style }: { model: RailModel; className?: string; style?: React.CSSProperties }) {
  const location = useLocation();
  const moreActive = model.active?.startsWith("more:") ?? false;
  const more = useMoreRoll(location.pathname, moreActive);
  const property = model.properties.find((entry) => entry.id === model.propertyId);
  return (
    <nav
      aria-label="Rooms"
      data-testid="room-rail"
      className={cn(
        "flex w-[4.125rem] flex-col items-center gap-px border-r border-border bg-secondary/80 pb-1 pt-[max(0.25rem,env(safe-area-inset-top))]",
        className,
      )}
      style={style}
    >
      {model.properties.length > 1 && (
        <PropertyMenu model={model} side="right">
          <button type="button" className={tileClass(false)} aria-label={`Property: ${property?.name ?? "All properties"}. Change`}>
            <House aria-hidden="true" className="size-[1.3rem]" strokeWidth={1.8} />
            <span className="flex max-w-full items-center gap-0.5">
              <span className="truncate">{property?.name ?? "Homes"}</span>
              <ChevronDown aria-hidden="true" className="size-2.5 shrink-0" strokeWidth={3} />
            </span>
          </button>
        </PropertyMenu>
      )}
      <Tile to="/items" label="All" title="All items" icon={model.properties.length > 1 ? LayoutGrid : House} active={model.active === "all"} />
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <div
          className="no-scrollbar flex h-full flex-col items-center gap-px overflow-y-auto overscroll-contain"
          // Rooms under the rolled-up choices must not take focus.
          inert={more.state === "open"}
        >
          {model.rooms.map((room) => (
            <Tile key={room.id} to={`/rooms/${room.id}`} label={room.name} icon={roomIcon(room.name)} active={model.active === room.id} />
          ))}
        </div>
        {more.state !== "closed" && (
          <div
            id="rail-more"
            data-testid="rail-more"
            onAnimationEnd={more.onAnimationEnd}
            className={cn(
              "no-scrollbar absolute inset-0 flex flex-col items-center gap-px overflow-y-auto overscroll-contain bg-secondary",
              more.state === "open" ? "animate-roll-up" : "animate-roll-down",
            )}
          >
            {MORE_DESTINATIONS.filter((entry) => entry.to !== "/loans").map((entry) => (
              <Tile key={entry.to} to={entry.to} label={entry.short} title={entry.label} icon={entry.icon} active={model.active === `more:${entry.to}`} />
            ))}
          </div>
        )}
      </div>
      <span aria-hidden="true" className="my-1 h-px w-9 bg-border" />
      <Tile to="/loans" label="On loan" icon={Handshake} active={model.active === "loans"} badge={model.overdue} />
      <button
        type="button"
        className={tileClass(moreActive && more.state !== "open")}
        aria-expanded={more.state === "open"}
        aria-controls="rail-more"
        onClick={more.toggle}
      >
        {more.state === "open" ? (
          <X aria-hidden="true" className="size-[1.3rem]" strokeWidth={1.8} />
        ) : (
          <Menu aria-hidden="true" className="size-[1.3rem]" strokeWidth={1.8} />
        )}
        <span>{more.state === "open" ? "Close" : "More"}</span>
      </button>
    </nav>
  );
}

const rowClass = (active: boolean) => cn("nav-link min-h-11", active && "nav-link-active");

function Row({
  to,
  label,
  icon: Icon,
  active,
  count,
  countLabel,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  count?: number;
  countLabel?: string;
}) {
  return (
    <Link to={to} aria-current={active ? "page" : undefined} className={rowClass(active)}>
      <Icon aria-hidden="true" className="size-[1.05rem] shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {count}
          {countLabel && <span className="sr-only"> {countLabel}</span>}
        </span>
      )}
    </Link>
  );
}

/** The desktop sidebar list: the same places as the rail, with names and counts. */
export function SidebarNav({ model }: { model: RailModel }) {
  const location = useLocation();
  const moreActive = model.active?.startsWith("more:") ?? false;
  const more = useMoreRoll(location.pathname, moreActive);
  const property = model.properties.find((entry) => entry.id === model.propertyId);
  return (
    <nav aria-label="Rooms" className="mt-4 flex min-h-0 flex-1 flex-col gap-1">
      {model.properties.length > 1 && (
        <PropertyMenu model={model} side="bottom">
          <button type="button" className={cn(rowClass(false), "w-full text-left")} aria-label={`Property: ${property?.name ?? "All properties"}. Change`}>
            <House aria-hidden="true" className="size-[1.05rem] shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate">{property?.name ?? "All properties"}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </button>
        </PropertyMenu>
      )}
      <Row to="/items" label="All items" icon={model.properties.length > 1 ? LayoutGrid : House} active={model.active === "all"} />
      <div className="relative min-h-24 flex-1 overflow-hidden">
        <div
          className="flex h-full flex-col gap-1 overflow-y-auto overscroll-contain pr-1"
          inert={more.state === "open"}
        >
          {model.rooms.map((room) => (
            <Row
              key={room.id}
              to={`/rooms/${room.id}`}
              label={room.name}
              icon={roomIcon(room.name)}
              active={model.active === room.id}
              count={room.total_item_count}
              countLabel="items"
            />
          ))}
          {model.rooms.length === 0 && (
            <p className="px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
              Rooms you add appear here.
            </p>
          )}
        </div>
        {more.state !== "closed" && (
          <div
            id="sidebar-more"
            data-testid="rail-more"
            onAnimationEnd={more.onAnimationEnd}
            className={cn(
              "absolute inset-0 flex flex-col gap-1 overflow-y-auto overscroll-contain bg-background pr-1",
              more.state === "open" ? "animate-roll-up" : "animate-roll-down",
            )}
          >
            {MORE_DESTINATIONS.filter((entry) => entry.to !== "/loans").map((entry) => (
              <Row key={entry.to} to={entry.to} label={entry.label} icon={entry.icon} active={model.active === `more:${entry.to}`} />
            ))}
          </div>
        )}
      </div>
      <span aria-hidden="true" className="mx-3 my-1 h-px bg-border" />
      <Row to="/loans" label="On loan" icon={Handshake} active={model.active === "loans"} count={model.onLoan || undefined} countLabel="open loans" />
      <button
        type="button"
        className={cn(rowClass(moreActive && more.state !== "open"), "w-full text-left")}
        aria-expanded={more.state === "open"}
        aria-controls="sidebar-more"
        onClick={more.toggle}
      >
        {more.state === "open" ? (
          <X aria-hidden="true" className="size-[1.05rem] shrink-0" strokeWidth={1.8} />
        ) : (
          <Menu aria-hidden="true" className="size-[1.05rem] shrink-0" strokeWidth={1.8} />
        )}
        {more.state === "open" ? "Close" : "More"}
      </button>
    </nav>
  );
}
