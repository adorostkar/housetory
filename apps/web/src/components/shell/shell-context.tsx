import * as React from "react";

interface ShellState {
  /** The phone layout with the room rail (below the desktop breakpoint). */
  compact: boolean;
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
}

const ShellContext = React.createContext<ShellState | null>(null);

export const ShellProvider = ShellContext.Provider;

/** Null outside the app shell, for example in tests that render one page. */
export function useShell(): ShellState | null {
  return React.useContext(ShellContext);
}

const RAIL_KEY = "housetory-rail";

/** The rail is open the first time, then stays as the user left it. */
export function useRememberedRail(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = React.useState(() => {
    try {
      return window.localStorage.getItem(RAIL_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const change = React.useCallback((next: boolean) => {
    setOpen(next);
    try {
      if (next) window.localStorage.removeItem(RAIL_KEY);
      else window.localStorage.setItem(RAIL_KEY, "hidden");
    } catch {
      // The rail still opens and closes for this visit.
    }
  }, []);
  return [open, change];
}
