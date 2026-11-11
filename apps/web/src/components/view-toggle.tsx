import { LayoutGrid, List } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export type ItemsView = "grid" | "list";

const STORAGE_KEY = "housetory.items.view";

/** Grid/list preference shared by the Items and Home pages. */
export function useItemsView(
  fallback: () => ItemsView = () => "grid",
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

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, view);
    } catch {
      // Browsing-private storage failures should not break the list.
    }
  }, [view]);

  return [view, setView];
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
      <Icon className="size-3.5" />
    </button>
  );
  return (
    <div
      className="flex items-center gap-0 rounded-lg border border-border/70 bg-card/55 p-0.5 sm:gap-1 sm:p-1"
      role="group"
      aria-label="Item view"
    >
      {button("grid", "Card view", LayoutGrid)}
      {button("list", "Compact list view", List)}
    </div>
  );
}
