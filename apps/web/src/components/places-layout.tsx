import { NavLink, Outlet, useLocation } from "react-router-dom";

import { withHousehold } from "@/lib/household-links";
import { cn } from "@/lib/utils";

const PLACES_TABS = [
  { to: "/rooms", label: "Rooms" },
  { to: "/containers", label: "Containers" },
] as const;

export function isPlacesPath(pathname: string) {
  return PLACES_TABS.some(
    (tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`),
  );
}

export function PlacesLayout() {
  const location = useLocation();
  const householdId = new URLSearchParams(location.search).get("household_id");
  return (
    <div>
      <nav
        aria-label="Places"
        className="no-scrollbar mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border/60"
      >
        {PLACES_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={withHousehold(tab.to, householdId)}
            end
            className={({ isActive }) =>
              cn(
                "-mb-px flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition-colors",
                isActive
                  ? "border-sage text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
