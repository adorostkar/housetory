import { DoorOpen, House, Package, Plus, Search } from "lucide-react";
import { Suspense, useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { AccountMenu } from "@/components/account-menu";
import { BrandMark } from "@/components/brand-mark";
import { PageFallback } from "@/components/page-fallback";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const primaryNav = [
  { to: "/", label: "Overview", icon: House, end: true },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, end: false },
  { to: "/items", label: "Items", icon: Package, end: false },
  { to: "/search", label: "Search", icon: Search, end: false },
] as const;

const mobileNav = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, end: false },
  { to: "/items", label: "Items", icon: Package, end: false },
  { to: "/search", label: "Search", icon: Search, end: false },
] as const;

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigate("/search");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border/60 bg-background/35 px-4 py-6 lg:flex">
        <div className="flex items-center justify-between px-2">
          <Link to="/" aria-label="Housetory home">
            <BrandMark />
          </Link>
          <ThemeToggle className="-mr-2" />
        </div>

        <Button asChild className="mt-8 w-full justify-start pl-4">
          <Link to="/items/new">
            <Plus />
            Add an item
          </Link>
        </Button>

        <nav className="mt-8 space-y-1" aria-label="Primary">
          <p className="eyebrow mb-3 px-3">Everything has a place</p>
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => cn("nav-link", isActive && "nav-link-active")}
            >
              <item.icon className="size-[1.05rem]" strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto">
          <div className="mb-4 rounded-2xl border border-border/60 bg-card/45 px-4 py-3.5">
            <p className="font-display text-[1.05rem] leading-snug tracking-[-0.01em] text-foreground/90">
              A calm record of everything you own.
            </p>
            <p className="mt-1.5 text-[0.72rem] leading-relaxed text-muted-foreground">
              Private, self-hosted, and yours.
            </p>
          </div>
          <AccountMenu />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="glass safe-top sticky top-0 z-40 border-b border-border/60 lg:hidden">
          <div className="flex h-16 items-center justify-between px-5">
            <Link to="/" aria-label="Housetory home" className="flex items-center">
              <BrandMark compact />
              <span className="ml-2.5 font-display text-[1.25rem] tracking-[-0.02em]">
                Housetory
              </span>
            </Link>
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <Button asChild variant="ghost" size="icon" aria-label="Add an item">
                <Link to="/items/new">
                  <Plus className="size-[1.15rem]" />
                </Link>
              </Button>
              <AccountMenu compact />
            </div>
          </div>
        </header>

        <main className="mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-[1320px] px-5 pb-28 pt-7 sm:px-8 sm:pt-9 lg:min-h-dvh lg:px-12 lg:pb-20 lg:pt-12">
          <div key={location.pathname} className="animate-fade-in">
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </main>

        <nav
          className="glass safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border/60 px-3 pt-2 lg:hidden"
          aria-label="Primary"
        >
          <div className="mx-auto flex max-w-md items-stretch justify-around">
            {mobileNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "relative flex min-w-[4.25rem] flex-col items-center gap-1.5 rounded-xl px-3 py-2 text-[0.65rem] font-medium tracking-[0.01em] transition-colors",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className="size-[1.25rem]"
                      strokeWidth={isActive ? 2 : 1.7}
                    />
                    {item.label}
                    <span
                      className={cn(
                        "absolute -bottom-[5px] h-1 w-1 rounded-full bg-sage transition-opacity",
                        isActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
