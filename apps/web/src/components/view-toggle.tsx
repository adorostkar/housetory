import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export type ItemsView = "grid" | "list";

// The earlier key was written on every visit, so it could not tell a choice from
// the default. This one is written only when the user picks a view.
const STORAGE_KEY = "housetory.items.view.v2";

/**
 * Grid/list preference for the item lists. Compact rows are shown until the
 * user picks a view; the choice is then kept on this device.
 */
export function useItemsView(
  fallback: () => ItemsView = () => "list",
): [ItemsView, (view: ItemsView) => void] {
  const [view, setView] = useState<ItemsView>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "list" || stored === "grid") return stored;
    } catch {
      // Storage may be unavailable; use the fallback.
    }
    return fallback();
  });

  const choose = (next: ItemsView) => {
    setView(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Browsing-private storage failures should not break the list.
    }
  };

  return [view, choose];
}

export function ViewToggle({
  view,
  onChange,
}: {
  view: ItemsView;
  onChange: (view: ItemsView) => void;
}) {
  const button = (value: ItemsView, label: string, Icon: typeof List) => (
    <button
      type="button"
      className={cn(
        "flex size-11 items-center justify-center rounded-md transition-colors sm:size-7",
        view === value
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      aria-label={label}
      aria-pressed={view === value}
      onClick={() => onChange(value)}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
  return (
    <div
      className="flex shrink-0 items-center gap-0 rounded-lg border border-border/70 bg-card/55 p-0.5 sm:gap-1 sm:p-1"
      role="group"
      aria-label="Item view"
    >
      {button("list", "Compact list view", List)}
      {button("grid", "Card view", LayoutGrid)}
    </div>
  );
}
