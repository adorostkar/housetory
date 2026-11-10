import {
  Boxes,
  ClipboardCheck,
  DoorOpen,
  FileText,
  HandCoins,
  House,
  MoreHorizontal,
  Package,
  Search,
  Settings,
  Plus,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect } from "react";
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
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSoftwareKeyboardOpen } from "@/hooks/use-software-keyboard-open";
import { useCanWrite } from "@/lib/queries";
import { SearchSessionProvider } from "@/lib/search-session";
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
      { to: "/assistant", label: "Assistant", icon: Sparkles },
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

const mobileRightNav: NavItem[] = [
  { to: "/assistant", label: "Assistant", icon: Sparkles },
];

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
  { to: "/search", label: "Search", icon: Search },
  { to: "/settings", label: "Settings", icon: Settings },
];

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
      <AddItemsProvider>
        <AppShellLayout />
      </AddItemsProvider>
    </SearchSessionProvider>
  );
}

function AppShellLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const softwareKeyboardOpen = useSoftwareKeyboardOpen();
  const isAssistant = location.pathname === "/assistant";
  const { openAddItems } = useAddItems();
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
        } else {
          navigate("/search");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

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

        <AddItemsButton className="mt-4 w-full justify-start pl-4" />

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

      <div className="min-w-0">
        <header className="glass safe-top sticky top-0 z-40 border-b border-border/60 lg:hidden">
          <div className="flex h-16 items-center justify-between px-5">
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
        </header>

        {location.pathname !== "/assistant" && (
          <header className="sticky top-0 z-30 hidden border-b border-border/50 bg-background/70 backdrop-blur-xl lg:block">
            <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center justify-center px-12">
              <QuickSearch variant="top" className="w-full max-w-2xl" />
            </div>
          </header>
        )}

        <main
          className={cn(
            "mx-auto w-full max-w-[1320px] px-5 sm:px-8 lg:px-12",
            isAssistant
              ? cn(
                  "flex flex-col overflow-hidden pb-3 pt-3 lg:h-dvh lg:pb-6 lg:pt-6",
                  softwareKeyboardOpen
                    ? "h-[calc(100dvh-4rem)]"
                    : "h-[calc(100dvh-4rem-4.75rem-env(safe-area-inset-bottom))]",
                )
              : "min-h-[calc(100dvh-4rem)] pb-28 pt-5 sm:pt-7 lg:min-h-dvh lg:pb-20 lg:pt-8",
          )}
        >
          {location.pathname !== "/assistant" && (
            <div className="mb-5 lg:hidden">
              <QuickSearch variant="mobile" />
            </div>
          )}
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
            className={cn("animate-fade-in", isAssistant && "min-h-0 flex-1")}
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
            <div className="mx-auto flex max-w-md items-stretch justify-around">
              {mobileLeftNav.map(renderMobileTab)}
              {canWrite ? (
                <button
                  type="button"
                  aria-label="Add items"
                  onClick={(event) =>
                    openAddItems(undefined, event.currentTarget)
                  }
                  className="relative -mt-4 flex min-w-0 flex-1 flex-col items-center justify-start gap-0.5 px-1 text-2xs font-medium text-muted-foreground"
                >
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lift">
                    <Plus className="size-5" strokeWidth={2.2} />
                  </span>
                  Add
                </button>
              ) : null}
              {mobileRightNav.map(renderMobileTab)}
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
    </div>
  );
}
