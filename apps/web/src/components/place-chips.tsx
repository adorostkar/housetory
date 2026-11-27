import { ChevronDown, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { type ItemsView, ViewToggle } from "@/components/view-toggle";
import { cn } from "@/lib/utils";

const chipClass =
  "inline-flex min-h-9 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring coarse:min-h-11";
const idleClass = "border-border bg-card/70 text-foreground hover:bg-secondary/60";
const activeClass = "border-primary bg-primary text-primary-foreground";

/** One row of place chips. It scrolls sideways on a phone and wraps on wider screens. */
export function PlaceChipRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1 sm:flex-wrap sm:overflow-visible",
        className,
      )}
    >
      {children}
    </div>
  );
}

function chipLabel(name: string, count?: number) {
  if (count === undefined) return name;
  return `${name}, ${count} ${count === 1 ? "item" : "items"}`;
}

function ChipContent({
  icon,
  name,
  count,
}: {
  icon?: React.ReactNode;
  name: string;
  count?: number;
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 truncate">{name}</span>
      {count !== undefined && (
        <span className="shrink-0 font-normal tabular-nums opacity-70">{count}</span>
      )}
    </>
  );
}

/** A chip that narrows the list on this page to one place. */
export function PlaceFilterChip({
  name,
  count,
  icon,
  active,
  onClick,
}: {
  name: string;
  count?: number;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={chipLabel(name, count)}
      title={name}
      onClick={onClick}
      className={cn(chipClass, active ? activeClass : idleClass)}
    >
      <ChipContent icon={icon} name={name} count={count} />
    </button>
  );
}

/** A chip that opens the page of a place inside this one. */
export function PlaceLinkChip({
  to,
  name,
  count,
  icon,
}: {
  to: string;
  name: string;
  count?: number;
  icon?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-label={`Open ${chipLabel(name, count)}`}
      title={name}
      className={cn(chipClass, idleClass, "pr-2")}
    >
      <ChipContent icon={icon} name={name} count={count} />
      <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </Link>
  );
}

export type ContentsScope = "nested" | "direct";

/**
 * The one row of list tools on a room or container page, the same shape as on
 * the item list: sort, Filters, view. Filters holds the search inside this place
 * and the nested/direct choice. It starts closed; what is active shows as chips.
 */
export function PlaceListTools({
  sort,
  sortOptions,
  sortLabel,
  onSortChange,
  search,
  searchLabel,
  onSearchChange,
  scope,
  showScope,
  onScopeChange,
  view,
  showView,
  onViewChange,
}: {
  sort: string;
  sortOptions: Array<[value: string, label: string]>;
  sortLabel: string;
  onSortChange: (value: string) => void;
  search: string;
  searchLabel: string;
  onSearchChange: (value: string) => void;
  scope: ContentsScope;
  /** False when nothing can be nested here, so the choice would do nothing. */
  showScope: boolean;
  onScopeChange: (scope: ContentsScope) => void;
  view: ItemsView;
  showView: boolean;
  onViewChange: (view: ItemsView) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const term = search.trim();
  const chips = [
    term ? { key: "search", label: `Search: ${term}`, remove: () => onSearchChange("") } : null,
    scope === "direct"
      ? { key: "scope", label: "Direct only", remove: () => onScopeChange("nested") }
      : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);

  return (
    <>
      {/* One row of tools. It only wraps on the narrowest phones with the rooms open. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        <div className="w-[6.5rem] shrink-0 sm:w-36">
          <Select
            aria-label={sortLabel}
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
            className="rounded-lg pl-2.5 pr-7 text-sm [&+svg]:right-2"
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <button
          type="button"
          className="relative flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-input/90 bg-card/65 px-2.5 text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          {/* On phones the icon stands for the word, which stays in the accessible name. */}
          <span className="sr-only sm:not-sr-only">Filters</span>
          {chips.length > 0 && (
            <Badge
              variant="secondary"
              className="absolute -right-1.5 -top-1.5 border-background px-1.5 py-0 text-2xs sm:static sm:border-transparent"
            >
              <span className="sr-only">Active filters: </span>
              {chips.length}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "hidden size-4 text-muted-foreground transition-transform sm:block",
              open && "rotate-180",
            )}
          />
        </button>
        {showView && (
          <div className="ml-auto">
            <ViewToggle view={view} onChange={onViewChange} />
          </div>
        )}
      </div>

      {(open || chips.length > 0) && (
        <div className="surface mb-3 p-3">
          {open && (
            <div id={panelId} className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[10rem] flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Search here"
                  aria-label={searchLabel}
                  autoComplete="off"
                  className="pl-10"
                />
              </div>
              {showScope && (
                <div
                  className="inline-flex shrink-0 rounded-full border border-border/70 bg-background/50"
                  role="group"
                  aria-label="Contents scope"
                >
                  {(["nested", "direct"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={scope === value}
                      onClick={() => onScopeChange(value)}
                      className={cn(
                        "min-h-9 rounded-full px-3 text-2xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring coarse:min-h-11",
                        scope === value
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {value === "nested" ? "Include nested" : "Direct only"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {chips.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5",
                open && "mt-2 border-t border-border/60 pt-2",
              )}
            >
              {chips.map((chip) => (
                <Badge
                  key={chip.key}
                  variant="secondary"
                  className="max-w-full gap-1 py-0 pl-2.5 pr-0 text-2xs"
                >
                  <span className="min-w-0 truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.remove}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:size-7 coarse:!size-11"
                    aria-label={`Remove ${chip.label}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
