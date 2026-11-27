import { PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one bar of the app: show or hide the rooms (phone only), the search and ask
 * field, and Add. On the phone it is fixed to the bottom and stays above the
 * keyboard. On desktop it sits at the bottom of the main column.
 */
export function BottomBar({
  compact,
  hidden = false,
  railOpen,
  onToggleRail,
  canAdd,
  onAdd,
  keyboardOpen,
  children,
}: {
  compact: boolean;
  hidden?: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  canAdd: boolean;
  onAdd: (trigger: HTMLElement) => void;
  keyboardOpen: boolean;
  /** The search field. It gets all the room while it has focus on the phone. */
  children: (props: { onFocusChange: (focused: boolean) => void }) => React.ReactNode;
}) {
  const [typing, setTypingNow] = React.useState(false);
  // The field gives its extra room back a moment after it loses focus, not at
  // once. On a phone a tap on a button of the bar takes focus from the field
  // first. If the buttons moved in that moment, the tap would miss its button.
  const release = React.useRef(0);
  const setTyping = React.useCallback((focused: boolean) => {
    window.clearTimeout(release.current);
    if (focused) setTypingNow(true);
    else release.current = window.setTimeout(() => setTypingNow(false), 250);
  }, []);
  React.useEffect(() => () => window.clearTimeout(release.current), []);
  const narrow = compact && typing;
  return (
    <div
      data-always-on-screen
      data-testid="bottom-bar"
      className={cn(
        "z-40 border-t border-border/70 bg-background/95 backdrop-blur-xl",
        compact
          ? "fixed inset-x-0 bottom-[var(--keyboard-inset,0px)] px-2 pt-2"
          : "sticky bottom-[var(--keyboard-inset,0px)] px-12 pb-4 pt-3",
        compact && (keyboardOpen ? "pb-2" : "pb-[max(0.5rem,env(safe-area-inset-bottom))]"),
        hidden && "hidden",
      )}
    >
      <div className={cn("mx-auto flex w-full items-end gap-2", !compact && "max-w-[1224px] gap-3")}>
        {compact && !narrow && (
          <button
            type="button"
            aria-label={railOpen ? "Hide rooms" : "Show rooms"}
            aria-pressed={railOpen}
            title={railOpen ? "Hide rooms" : "Show rooms"}
            onClick={onToggleRail}
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-xl border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              railOpen
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-card text-foreground hover:bg-secondary",
            )}
          >
            {railOpen ? (
              <PanelLeftClose aria-hidden="true" className="size-5" />
            ) : (
              <PanelLeftOpen aria-hidden="true" className="size-5" />
            )}
          </button>
        )}
        {/* A phone held sideways with the keyboard open: the field takes the left part, the
            search results stand beside it. */}
        <div className={cn("min-w-0 flex-1", narrow && "[[data-keyboard-side]_&]:w-[42%] [[data-keyboard-side]_&]:flex-none")}>
          {children({ onFocusChange: setTyping })}
        </div>
        {!narrow && (
          <button
            type="button"
            aria-label="Add items"
            title={canAdd ? "Add items" : "Viewers cannot add items"}
            disabled={!canAdd}
            onClick={(event) => onAdd(event.currentTarget)}
            className={cn(
              "flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-primary text-primary-foreground shadow-lift transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
              compact ? "w-12" : "px-5 text-sm font-medium",
            )}
          >
            <Plus aria-hidden="true" className="size-5" strokeWidth={2.2} />
            {!compact && <span>Add</span>}
          </button>
        )}
      </div>
    </div>
  );
}
