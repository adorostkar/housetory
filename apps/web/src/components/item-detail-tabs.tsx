import { useRef } from "react";

import { cn } from "@/lib/utils";

export const ITEM_DETAIL_TABS = [
  { id: "contents", label: "Contents" },
  { id: "info", label: "Info" },
  { id: "documents", label: "Documents" },
  { id: "loans", label: "Loans" },
  { id: "history", label: "History" },
] as const;

export type ItemDetailTab = (typeof ITEM_DETAIL_TABS)[number]["id"];

/** Reads `?tab=`. "details" is the old name of the Info tab and still works. */
export function parseItemDetailTab(value: string | null): ItemDetailTab | null {
  if (value === "details") return "info";
  return ITEM_DETAIL_TABS.find((tab) => tab.id === value)?.id ?? null;
}

/**
 * Accessible tab list with roving tabindex and arrow/Home/End navigation.
 * `idPrefix` keeps the element ids apart when the item is shown twice.
 */
export function ItemDetailTabList({
  value,
  onChange,
  tabs,
  counts = {},
  idPrefix,
}: {
  value: ItemDetailTab;
  onChange: (tab: ItemDetailTab) => void;
  tabs: readonly ItemDetailTab[];
  counts?: Partial<Record<ItemDetailTab, number>>;
  idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const shown = ITEM_DETAIL_TABS.filter((tab) => tabs.includes(tab.id));

  function onKeyDown(event: React.KeyboardEvent) {
    const index = shown.findIndex((tab) => tab.id === value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % shown.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + shown.length) % shown.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = shown.length - 1;
    else return;
    event.preventDefault();
    const target = shown[next]!.id;
    onChange(target);
    refs.current[target]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Item sections"
      onKeyDown={onKeyDown}
      className="no-scrollbar -mx-1 mb-4 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border/60 px-1 pb-px"
    >
      {shown.map((tab) => {
        const selected = tab.id === value;
        const count = counts[tab.id] ?? 0;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-tabpanel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-brass text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {count > 0 && (
              <span className="rounded-full bg-secondary px-1.5 text-2xs tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
