import {
  Boxes,
  ClipboardCheck,
  DoorOpen,
  FileText,
  HandCoins,
  House,
  MoreHorizontal,
  Package,
  Settings,
  Plus,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { AccountMenu } from "@/components/account-menu";
import {
  AddItemsButton,
  AddItemsProvider,
  useAddItems,
} from "@/components/add-items";
import { isFinancialsPath } from "@/components/financials-layout";
import { BrandMark } from "@/components/brand-mark";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { PageFallback } from "@/components/page-fallback";
import { QuickSearch } from "@/components/quick-search";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSoftwareKeyboardOpen } from "@/hooks/use-software-keyboard-open";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useCanWrite, useReviewSummary } from "@/lib/queries";
import { SearchSessionProvider } from "@/lib/search-session";
import { AssistantConversationProvider } from "@/lib/assistant-conversation";
import { useAssistantDocuments } from "@/lib/assistant-documents";
import {
  ASSISTANT_TASK_COMPLETED_EVENT,
  type AssistantTaskCompletion,
} from "@/lib/assistant-task-events";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  match?: (pathname: string) => boolean;
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Home",
    items: [
      { to: "/", label: "Overview", icon: House, end: true },
    ],
  },
  {
    label: "Inventory",
    items: [
      { to: "/items", label: "Items", icon: Package },
      { to: "/rooms", label: "Rooms", icon: DoorOpen },
      { to: "/containers", label: "Containers", icon: Boxes },
      { to: "/loans", label: "Loans", icon: HandCoins },
    ],
  },
  {
    label: "Records",
    items: [
      { to: "/documents", label: "Documents", icon: FileText },
      {
        to: "/purchases",
        label: "Financials",
        icon: Wallet,
        match: isFinancialsPath,
      },
    ],
  },
  {
    label: "Tools",
    items: [{ to: "/review", label: "Review", icon: ClipboardCheck }],
  },
];

const mobileLeftNav: NavItem[] = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/items", label: "Items", icon: Package },
];

const mobileLoansNav: NavItem = {
  to: "/loans",
  label: "Loans",
  icon: HandCoins,
};

const AssistantPage = lazy(() =>
  import("@/pages/assistant-page").then((module) => ({ default: module.AssistantPage })),
);

const mobileMoreNav: NavItem[] = [
  { to: "/rooms", label: "Rooms", icon: DoorOpen },
  { to: "/containers", label: "Containers", icon: Boxes },
  { to: "/loans", label: "Loans", icon: HandCoins },
  { to: "/documents", label: "Documents", icon: FileText },
  {
    to: "/purchases",
    label: "Financials",
    icon: Wallet,
    match: isFinancialsPath,
  },
  { to: "/review", label: "Review", icon: ClipboardCheck },
  { to: "/settings", label: "Settings", icon: Settings },
];

const notifiedTaskKeys = new Set<string>();

function navItemActive(item: NavItem, pathname: string) {
  if (item.match) return item.match(pathname);
  return item.end
    ? pathname === item.to
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function mobileTabClass(active: boolean) {
  return cn(
    "relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-2xs font-medium tracking-[0.01em] transition-colors",
    active ? "text-foreground" : "text-muted-foreground",
  );
}

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
  const [assistantRequest, setAssistantRequest] = useState<{
    id: string;
    text: string;
    file?: File;
  } | null>(null);
  const assistantTrigger = useRef<HTMLElement | null>(null);
  const assistantHeading = useRef<HTMLHeadingElement | null>(null);
  const restoreAssistantFocus = useRef(false);
  const { openAddItems } = useAddItems();
  const { select: selectDocument, selectImport, selectPhoto, pendingReviews } = useAssistantDocuments();
  const reviewCount = (reviewSummary.data?.pending_count ?? 0) + pendingReviews.length;
  const desktop = useMediaQuery("(min-width: 1024px)");
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
  const moreActive = mobileMoreNav.some((item) =>
    navItemActive(item, location.pathname),
  );

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
        } else navigate("/");
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
            assistantTrigger.current?.focus();
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

  const renderMobileTab = (item: NavItem) => {
    const active = navItemActive(item, location.pathname);
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        aria-current={active ? "page" : undefined}
        className={mobileTabClass(active)}
      >
        <item.icon className="size-[1.25rem]" strokeWidth={active ? 2 : 1.7} />
        {item.label}
        <span
          className={cn(
            "absolute bottom-0.5 h-1 w-1 rounded-full bg-sage transition-opacity",
            active ? "opacity-100" : "opacity-0",
          )}
        />
      </NavLink>
    );
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-border/60 bg-background/35 px-4 py-6 lg:flex">
        <div className="flex items-center justify-between px-2">
          <Link to="/" aria-label="Housetory home">
            <BrandMark />
          </Link>
          <ThemeToggle className="-mr-2" />
        </div>

        <HouseholdSwitcher />

        <AddItemsButton className="mt-4 h-11 min-h-11 w-full shrink-0 justify-start px-4 py-2" />
        <nav className="mt-6 space-y-5" aria-label="Primary">
          {navGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <p className="eyebrow mb-2 px-3">{group.label}</p>
              {group.items.map((item) => {
                const active = navItemActive(item, location.pathname);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    aria-current={active ? "page" : undefined}
                    className={cn("nav-link", active && "nav-link-active")}
                  >
                    <item.icon className="size-[1.05rem]" strokeWidth={1.8} />
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto">
          <div className="mb-4 rounded-2xl border border-border/60 bg-card/45 px-4 py-3.5">
            <p className="font-display text-[1.05rem] leading-snug tracking-[-0.01em] text-foreground/90">
              A calm record of everything you own.
            </p>
            <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
              Private, self-hosted, and yours.
            </p>
          </div>
          <AccountMenu />
        </div>
      </aside>

      <div className={cn("min-w-0", assistantOpen && "lg:pr-[min(34rem,40vw)]")}>
        <header className="glass safe-top sticky top-0 z-30 border-b border-border/60">
          <div className="flex h-14 items-center justify-between px-5 lg:hidden">
            <Link
              to="/"
              aria-label="Housetory home"
              className="flex items-center"
            >
              <BrandMark compact />
              <span className="ml-2.5 font-display text-[1.25rem] tracking-[-0.02em]">
                Housetory
              </span>
            </Link>
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <AccountMenu compact />
            </div>
          </div>
          <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center justify-center px-3 sm:px-5 lg:px-12">
            <QuickSearch
              variant="top"
              className="w-full max-w-2xl"
              onAsk={(query, trigger) => openAssistant(query, trigger)}
              onAttach={canWrite ? (file, trigger, query) => openAssistant(query, trigger, file) : undefined}
              onOpenAssistant={openAssistantPanel}
              reviewCount={reviewCount}
            />
          </div>
        </header>

        <main
          className={cn(
            "mx-auto w-full max-w-[1320px] px-5 sm:px-8 lg:px-12",
            "min-h-[calc(100dvh-7.5rem)] pb-28 pt-5 sm:pt-7 lg:min-h-dvh lg:pb-20 lg:pt-8",
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

        {!softwareKeyboardOpen && (
          <nav
            className="glass safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border/60 px-3 pt-2 lg:hidden"
            aria-label="Primary"
            data-testid="mobile-bottom-nav"
          >
            <div className="mx-auto grid max-w-md grid-cols-5 items-stretch">
              {mobileLeftNav.map(renderMobileTab)}
              <button
                type="button"
                aria-label="Add items"
                onClick={
                  canWrite
                    ? (event) => openAddItems(undefined, event.currentTarget)
                    : undefined
                }
                disabled={!canWrite}
                className="relative -mt-4 flex w-full min-w-0 flex-col items-center justify-start gap-0.5 px-1 text-2xs font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lift">
                  <Plus className="size-5" strokeWidth={2.2} />
                </span>
                Add
              </button>
              {renderMobileTab(mobileLoansNav)}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={mobileTabClass(moreActive)}
                    aria-label="More destinations"
                    data-active={moreActive}
                  >
                    <MoreHorizontal
                      className="size-[1.25rem]"
                      strokeWidth={1.8}
                    />
                    More
                    <span
                      className={cn(
                        "absolute bottom-0.5 h-1 w-1 rounded-full bg-sage transition-opacity",
                        moreActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  sideOffset={10}
                  data-testid="mobile-more-menu"
                  className="max-h-[min(70dvh,26rem)] w-60 overflow-y-auto"
                >
                  <DropdownMenuLabel className="normal-case tracking-normal">
                    More destinations
                  </DropdownMenuLabel>
                  {mobileMoreNav.map((item) => (
                    <DropdownMenuItem
                      key={item.to}
                      className="min-h-11 cursor-pointer gap-2.5 px-3 text-sm"
                      onSelect={() => navigate(item.to)}
                    >
                      <item.icon className="size-4" />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </nav>
        )}
      </div>
      <DialogPrimitive.Root open={assistantOpen} modal={!desktop} onOpenChange={(open) => { if (!open) closeAssistant(); }}>
        <DialogPrimitive.Portal>
          {!desktop && <DialogPrimitive.Overlay className="fixed inset-0 z-50" />}
        <DialogPrimitive.Content
          aria-labelledby="assistant-panel-title"
          aria-describedby={undefined}
          data-testid="assistant-panel"
          onOpenAutoFocus={(event) => { event.preventDefault(); assistantHeading.current?.focus(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); }}
          onInteractOutside={(event) => { if (desktop) event.preventDefault(); }}
          className="fixed inset-0 z-50 flex h-dvh min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground shadow-lift outline-none lg:inset-y-0 lg:left-auto lg:top-16 lg:h-[calc(100dvh-4rem)] lg:w-[min(34rem,40vw)] lg:border-l lg:border-border/80"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <DialogPrimitive.Title asChild><h2
              id="assistant-panel-title"
              ref={assistantHeading}
              tabIndex={-1}
              className="text-sm"
            >
              Assistant
            </h2></DialogPrimitive.Title>
            <div className="flex items-center gap-2">
              <Link to="/review" className="inline-flex min-h-11 items-center text-xs underline">Review queue</Link>
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
  );
}
