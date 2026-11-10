import { useRef } from "react";

import { cn } from "@/lib/utils";

export const ITEM_DETAIL_TABS = [
  { id: "details", label: "Details" },
  { id: "documents", label: "Documents" },
  { id: "loans", label: "Loans" },
  { id: "history", label: "History" },
] as const;

export type ItemDetailTab = (typeof ITEM_DETAIL_TABS)[number]["id"];

export function parseItemDetailTab(value: string | null): ItemDetailTab {
  return ITEM_DETAIL_TABS.find((tab) => tab.id === value)?.id ?? "details";
}

/** Accessible tab list with roving tabindex and arrow/Home/End navigation. */
export function ItemDetailTabList({
  value,
  onChange,
}: {
  value: ItemDetailTab;
  onChange: (tab: ItemDetailTab) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: React.KeyboardEvent) {
    const index = ITEM_DETAIL_TABS.findIndex((tab) => tab.id === value);
    let next = index;
    if (event.key === "ArrowRight")
      next = (index + 1) % ITEM_DETAIL_TABS.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + ITEM_DETAIL_TABS.length) % ITEM_DETAIL_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ITEM_DETAIL_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = ITEM_DETAIL_TABS[next]!.id;
    onChange(target);
    refs.current[target]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Item sections"
      onKeyDown={onKeyDown}
      className="-mx-1 mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border/60 px-1 pb-px"
    >
      {ITEM_DETAIL_TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={`item-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls="item-tabpanel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-brass text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
