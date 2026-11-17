import * as React from "react";
import {
  UNSAFE_NavigationContext as NavigationContext,
  parsePath,
  useLocation,
  type Navigator,
  type To,
} from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Guard {
  shouldBlock: () => boolean;
  onDiscard: () => void;
}

interface GuardRegistry {
  register: (guard: Guard) => () => void;
}

const GuardContext = React.createContext<GuardRegistry | null>(null);

function historyIndex(state: unknown): number | null {
  if (!state || typeof state !== "object" || !("idx" in state)) return null;
  return typeof state.idx === "number" ? state.idx : null;
}

/**
 * Asks before an in-app navigation leaves a page that registered a guard with
 * `useNavigationGuard`. It sits inside the router and covers links, programmatic
 * navigation and the browser's back/forward buttons. Navigations that keep the
 * current pathname (search or hash changes) leave the page mounted and pass.
 */
export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const navigation = React.useContext(NavigationContext);
  const { navigator } = navigation;
  const location = useLocation();
  const guards = React.useRef(new Set<Guard>());
  const [pending, setPending] = React.useState<{ proceed: () => void } | null>(null);

  const pathname = React.useRef(location.pathname);
  pathname.current = location.pathname;
  const currentIndex = React.useRef<number | null>(null);
  React.useEffect(() => {
    currentIndex.current = historyIndex(window.history.state);
  }, [location]);

  const blocks = React.useCallback((targetPathname: string) => {
    if (targetPathname === pathname.current) return false;
    return [...guards.current].some((guard) => guard.shouldBlock());
  }, []);

  const guardedNavigator = React.useMemo<Navigator>(() => {
    const attempt = (to: To, proceed: () => void) => {
      const target = typeof to === "string" ? parsePath(to).pathname : to.pathname;
      if (target === undefined || !blocks(target)) proceed();
      else setPending({ proceed });
    };
    return {
      ...navigator,
      push: (to, state, opts) => attempt(to, () => navigator.push(to, state, opts)),
      replace: (to, state, opts) =>
        attempt(to, () => navigator.replace(to, state, opts)),
    };
  }, [navigator, blocks]);

  const guardedNavigation = React.useMemo(
    () => ({ ...navigation, navigator: guardedNavigator }),
    [navigation, guardedNavigator],
  );

  // The browser has already moved by the time popstate fires, so a guarded
  // back/forward is undone before the router hears about it and replayed only
  // if the user confirms.
  const revertingTo = React.useRef<number | null>(null);
  const replaying = React.useRef(false);
  React.useLayoutEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const to = historyIndex(event.state);
      if (revertingTo.current !== null && to === revertingTo.current) {
        revertingTo.current = null;
        event.stopImmediatePropagation();
        return;
      }
      if (replaying.current) {
        replaying.current = false;
        return;
      }
      const from = currentIndex.current;
      if (from === null || to === null || to === from) return;
      if (!blocks(window.location.pathname)) return;
      event.stopImmediatePropagation();
      const delta = to - from;
      revertingTo.current = from;
      window.history.go(-delta);
      setPending({
        proceed: () => {
          replaying.current = true;
          window.history.go(delta);
        },
      });
    };
    // Capture, and registered before the router's own listener, so it runs first.
    window.addEventListener("popstate", onPopState, true);
    return () => window.removeEventListener("popstate", onPopState, true);
  }, [blocks]);

  const registry = React.useMemo<GuardRegistry>(
    () => ({
      register: (guard) => {
        guards.current.add(guard);
        return () => {
          guards.current.delete(guard);
          if (guards.current.size === 0) setPending(null);
        };
      },
    }),
    [],
  );

  const discard = () => {
    const action = pending;
    setPending(null);
    for (const guard of guards.current) {
      if (guard.shouldBlock()) guard.onDiscard();
    }
    action?.proceed();
  };

  return (
    <GuardContext.Provider value={registry}>
      <NavigationContext.Provider value={guardedNavigation}>
        {children}
      </NavigationContext.Provider>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have changes that have not been saved. Leaving this page
              discards them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={discard}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GuardContext.Provider>
  );
}

/**
 * Guards the current page while `when` is true: in-app navigation asks for
 * confirmation (when a `NavigationGuardProvider` is present) and leaving the
 * document triggers the browser's own prompt where it is supported.
 * `onDiscard` runs when the user confirms leaving. Call the returned function
 * before a navigation that must not prompt, such as after a successful save.
 */
export function useNavigationGuard(when: boolean, onDiscard?: () => void): () => void {
  const registry = React.useContext(GuardContext);
  const latest = React.useRef({ when, onDiscard });
  latest.current = { when, onDiscard };
  const released = React.useRef(false);

  React.useEffect(() => {
    if (!registry) return;
    return registry.register({
      shouldBlock: () => latest.current.when && !released.current,
      onDiscard: () => latest.current.onDiscard?.(),
    });
  }, [registry]);

  React.useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (released.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  return React.useCallback(() => {
    released.current = true;
  }, []);
}
