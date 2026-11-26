import { ClipboardCheck, Maximize2, Minimize2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

import { AccountMenu } from "@/components/account-menu";
import { AddItemsProvider, useAddItems } from "@/components/add-items";
import { BrandMark } from "@/components/brand-mark";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { PageFallback } from "@/components/page-fallback";
import { QuickSearch } from "@/components/quick-search";
import { BottomBar } from "@/components/shell/bottom-bar";
import { RoomRail, SidebarNav, useRailModel } from "@/components/shell/room-rail";
import { ShellProvider, useRememberedRail } from "@/components/shell/shell-context";
import { toast } from "sonner";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { useSoftwareKeyboardOpen } from "@/hooks/use-software-keyboard-open";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useCanWrite, usePendingActions, useReviewSummary } from "@/lib/queries";
import { SearchSessionProvider } from "@/lib/search-session";
import { AssistantConversationProvider } from "@/lib/assistant-conversation";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import {
  ASSISTANT_TASK_COMPLETED_EVENT,
  type AssistantTaskCompletion,
} from "@/lib/assistant-task-events";
import { cn } from "@/lib/utils";

const AssistantPage = lazy(() =>
  import("@/pages/assistant-page").then((module) => ({ default: module.AssistantPage })),
);

// Bar height: 48 px field, 8 px above, and the safe area (at least 8 px) below.
const BAR_HEIGHT = "calc(3.5rem + max(0.5rem, env(safe-area-inset-bottom, 0px)))";

const notifiedTaskKeys = new Set<string>();

export function AppShell() {
  return (
    <SearchSessionProvider>
      <AssistantConversationProvider>
        <AddItemsProvider>
          <AppShellLayout />
        </AddItemsProvider>
      </AssistantConversationProvider>
    </SearchSessionProvider>
  );
}

function AppShellLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const reviewSummary = useReviewSummary();
  const softwareKeyboardOpen = useSoftwareKeyboardOpen();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantHeader, setAssistantHeader] = useState<HTMLDivElement | null>(null);
  const [assistantRequest, setAssistantRequest] = useState<{
    id: string;
    text: string;
    file?: File;
    capture?: { kind: "items" | "document" | "photo" | "action"; id: string };
  } | null>(null);
  const assistantTrigger = useRef<HTMLElement | null>(null);
  const assistantHeading = useRef<HTMLHeadingElement | null>(null);
  const restoreAssistantFocus = useRef(false);
  const { openAddItems } = useAddItems();
  const { select: selectDocument, selectImport, selectPhoto, pendingReviews } = useAssistantDocuments();
  // Captures handed straight to the inline review need no separate "ready" toast.
  const handedToReview = useRef(new Set<string>());
  const pendingActions = usePendingActions();
  const reviewCount = (reviewSummary.data?.pending_count ?? 0) + pendingReviews.length
    + (pendingActions.data?.total ?? 0);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [railOpen, setRailOpen] = useRememberedRail();
  const [assistantTall, setAssistantTall] = useState(false);
  const rail = useRailModel();
  useKeyboardInset();
  useEffect(() => {
    // Things fixed to the bottom of the screen (bulk bars, save bars) sit above the bar.
    const root = document.documentElement;
    root.style.setProperty("--shell-bar-height", BAR_HEIGHT);
    return () => {
      root.style.removeProperty("--shell-bar-height");
    };
  }, []);
  const closeAssistant = useCallback(() => {
    restoreAssistantFocus.current = true;
    setAssistantOpen(false);
    if (location.hash === "#assistant") {
      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: "",
        },
        { replace: true },
      );
    }
  }, [location.hash, location.pathname, location.search, navigate]);
  const openTaskReview = useCallback((task: AssistantTaskCompletion) => {
    if (task.kind === "document") selectDocument(task.id);
    else if (task.kind === "photo") selectPhoto(task.id);
    else selectImport(task.id);
    setAssistantRequest({
      id: crypto.randomUUID(), text: "",
      capture: { kind: task.kind === "import" ? "items" : task.kind, id: task.id },
    });
    restoreAssistantFocus.current = true;
    assistantTrigger.current = document.querySelector<HTMLButtonElement>('button[title="Open assistant"]');
    if (location.hash === "#assistant") {
      setAssistantOpen(true);
    } else {
      navigate({
        pathname: location.pathname,
        search: location.search,
        hash: "#assistant",
      });
    }
  }, [location.hash, location.pathname, location.search, navigate, selectDocument, selectImport, selectPhoto]);
  useEffect(() => {
    if (location.hash !== "#assistant") return;
    const state: unknown = location.state;
    if (!state || typeof state !== "object" || !("assistantCapture" in state)) return;
    const capture = state.assistantCapture;
    if (!capture || typeof capture !== "object" || !("id" in capture) || typeof capture.id !== "string"
      || !("kind" in capture)) return;
    if (capture.kind !== "items" && capture.kind !== "document" && capture.kind !== "photo"
      && capture.kind !== "action") return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      assistantTrigger.current = document.activeElement;
      restoreAssistantFocus.current = true;
    }
    if ("fresh" in capture && capture.fresh === true) handedToReview.current.add(capture.id);
    setAssistantRequest({ id: location.key, text: "", capture: { id: capture.id, kind: capture.kind } });
  }, [location.hash, location.key, location.state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            '[data-quick-search-input="true"]',
          ),
        );
        const input = inputs.find(
          (candidate) =>
            candidate.getClientRects().length > 0 &&
            window.getComputedStyle(candidate).visibility !== "hidden",
        );
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    restoreAssistantFocus.current = false;
    setAssistantOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (location.hash !== "#assistant") {
      setAssistantOpen(false);
      if (restoreAssistantFocus.current) {
        window.requestAnimationFrame(() => {
          if (window.location.hash !== "#assistant") {
            // No scrolling for this focus. A control in the sticky header is always on
            // screen, yet it sits inside the page's scroll padding, so the browser
            // would move the page to make room for it.
            assistantTrigger.current?.focus({ preventScroll: true });
            restoreAssistantFocus.current = false;
          }
        });
      }
      return;
    }

    setAssistantOpen(true);
    const params = new URLSearchParams(location.search);
    if (params.get("__assistant_legacy") !== "1") return;
    const text = params.get("q")?.trim() ?? "";
    if (text) setAssistantRequest({ id: crypto.randomUUID(), text });
    params.delete("__assistant_legacy");
    params.delete("q");
    params.delete("ask");
    params.delete("r");
    navigate(
      {
        pathname: location.pathname,
        search: params.size ? `?${params.toString()}` : "",
        hash: location.hash,
      },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!assistantOpen) return;
    const documentMatch = location.pathname.match(/^\/documents\/([^/]+)$/);
    if (documentMatch?.[1]) selectDocument(documentMatch[1]);
  }, [assistantOpen, location.pathname, selectDocument]);

  useEffect(() => {
    const onTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<AssistantTaskCompletion>).detail;
      if (!task?.id || !task.title || !task.description) return;
      const key = `${task.householdId}:${task.kind}:${task.id}:${task.generation}`;
      if (notifiedTaskKeys.has(key)) return;
      notifiedTaskKeys.add(key);
      try {
        if (window.sessionStorage.getItem(`housetory-assistant-task:${key}`)) return;
        window.sessionStorage.setItem(`housetory-assistant-task:${key}`, "shown");
      } catch {
        // The in-memory key still prevents repeat toasts in this page session.
      }
      if (handedToReview.current.delete(task.id)) return;
      toast.success(task.title, {
        id: key,
        description: task.description,
        action: {
          label: "Review",
          onClick: () => openTaskReview(task),
        },
      });
    };
    window.addEventListener(ASSISTANT_TASK_COMPLETED_EVENT, onTaskCompleted);
    return () => window.removeEventListener(ASSISTANT_TASK_COMPLETED_EVENT, onTaskCompleted);
  }, [openTaskReview]);

  const openAssistant = (text: string, trigger: HTMLElement, file?: File) => {
    restoreAssistantFocus.current = true;
    assistantTrigger.current = trigger;
    setAssistantRequest({ id: crypto.randomUUID(), text, ...(file ? { file } : {}) });
    if (location.hash !== "#assistant") {
      navigate({
        pathname: location.pathname,
        search: location.search,
        hash: "#assistant",
      });
    }
  };

  const openAssistantPanel = (trigger: HTMLElement) => {
    restoreAssistantFocus.current = true;
    assistantTrigger.current = trigger;
    if (location.hash !== "#assistant") {
      navigate({
        pathname: location.pathname,
        search: location.search,
        hash: "#assistant",
      });
    }
  };

  const compact = !desktop;
  const showRail = compact && railOpen;
  // The assistant has its own message field, so the bar steps aside for it on the phone.
  const showBar = !(compact && assistantOpen);

  return (
    <ShellProvider value={{ compact, railOpen, setRailOpen }}>
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      <aside data-always-on-screen className="sticky top-0 hidden h-dvh flex-col border-r border-border/60 bg-background/35 px-4 py-6 lg:flex">
        <div className="flex items-center px-2">
          <Link to="/items" aria-label="Housetory, all items">
            <BrandMark />
          </Link>
        </div>

        <HouseholdSwitcher />

        <SidebarNav model={rail} />

        <div className="mt-3 shrink-0">
          <AccountMenu />
        </div>
      </aside>

      {showRail && (
        <RoomRail
          model={rail}
          className="fixed left-0 top-0 z-30"
          style={{ bottom: `calc(${showBar ? "var(--shell-bar-height, 0px)" : "0px"} + var(--keyboard-inset, 0px))` }}
        />
      )}

      <div className={cn("flex min-h-dvh min-w-0 flex-col", showRail && "pl-[4.125rem]")}>
        <main
          className={cn(
            "mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-8 lg:px-12",
            "pb-[calc(var(--shell-bar-height,0px)+1.5rem)] pt-[max(1rem,env(safe-area-inset-top))] lg:pb-10 lg:pt-8",
          )}
        >
          {!canWrite && (
            <div className="mb-5 rounded-xl border border-brass/25 bg-brass-soft/40 px-4 py-3 text-2xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-brass">Viewer access.</span> You
              can browse and search this household. Inventory changes, scans,
              imports and settings are disabled; ask an owner if you need member
              access.
            </div>
          )}
          <div
            key={location.pathname}
            className="animate-fade-in"
          >
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </main>

        {/* Hidden, not removed, so focus can return to the button that opened the assistant. */}
        <BottomBar
            hidden={!showBar}
            compact={compact}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen(!railOpen)}
            canAdd={canWrite}
            onAdd={(trigger) => openAddItems(undefined, trigger)}
            keyboardOpen={softwareKeyboardOpen}
          >
            {({ onFocusChange }) => (
              <QuickSearch
                variant="top"
                placement="bottom"
                compact={compact}
                onFocusChange={onFocusChange}
                className="w-full"
                onAsk={(query, trigger) => openAssistant(query, trigger)}
                onAttach={canWrite ? (file, trigger, query) => openAssistant(query, trigger, file) : undefined}
                onOpenAssistant={openAssistantPanel}
                reviewCount={reviewCount}
              />
            )}
        </BottomBar>
      </div>
      <DialogPrimitive.Root open={assistantOpen} modal={!desktop} onOpenChange={(open) => { if (!open) closeAssistant(); }}>
        <DialogPrimitive.Portal>
          {!desktop && (
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--shadow-color)/0.38)] data-[state=open]:animate-fade-in" />
          )}
        <DialogPrimitive.Content
          aria-labelledby="assistant-panel-title"
          aria-describedby={undefined}
          data-testid="assistant-panel"
          data-tall={assistantTall || softwareKeyboardOpen}
          onOpenAutoFocus={(event) => { event.preventDefault(); assistantHeading.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); }}
          onInteractOutside={(event) => { if (desktop) event.preventDefault(); }}
          className={cn(
            "fixed z-50 flex min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground shadow-lift outline-none",
            // Phone: a sheet from the bottom that can go to full height. It stays above the keyboard.
            "inset-x-0 bottom-[var(--keyboard-inset,0px)] rounded-t-3xl border-t border-border/80 max-lg:data-[state=open]:animate-sheet-up",
            assistantTall || softwareKeyboardOpen ? "top-0 max-lg:rounded-t-none" : "top-[max(14dvh,env(safe-area-inset-top))]",
            // Desktop: a box above the bar, in the main column.
            "lg:inset-x-auto lg:bottom-4 lg:left-[calc(264px+3rem)] lg:w-[min(44rem,calc(100vw-264px-6rem))] lg:rounded-2xl lg:border lg:data-[state=open]:animate-fade-in",
            assistantTall ? "lg:top-4" : "lg:top-auto lg:h-[min(42rem,calc(100dvh-2rem))]",
          )}
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] lg:pt-3">
            <DialogPrimitive.Title asChild><h2
              id="assistant-panel-title"
              ref={assistantHeading}
              tabIndex={-1}
              className="sr-only"
            >
              Assistant
            </h2></DialogPrimitive.Title>
            <div ref={setAssistantHeader} className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setAssistantTall((tall) => !tall)}
                aria-pressed={assistantTall}
                aria-label={assistantTall ? "Make the assistant smaller" : "Make the assistant full height"}
                title={assistantTall ? "Smaller" : "Full height"}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-2"
              >
                {assistantTall ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
              <Link to="/review" aria-label="Review queue" title="Review queue"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-secondary focus-visible:outline focus-visible:outline-2">
                <ClipboardCheck className="size-4" />
              </Link>
              <button
                type="button"
                onClick={closeAssistant}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-2"
                aria-label="Close assistant"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <Suspense fallback={<PageFallback />}>
              <AssistantPage
                embedded
                headerContainer={assistantHeader}
                initialRequest={assistantRequest}
                onInitialRequestHandled={(id) => {
                  setAssistantRequest((current) => current?.id === id ? null : current);
                }}
              />
            </Suspense>
          </div>
        </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
    </ShellProvider>
  );
}
