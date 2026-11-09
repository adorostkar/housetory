import { NavLink, Outlet, useLocation } from "react-router-dom";

import { withHousehold } from "@/lib/household-links";
import { cn } from "@/lib/utils";

export const FINANCIALS_TABS = [
  { to: "/purchases", label: "Purchases" },
  { to: "/warranties", label: "Warranties" },
  { to: "/insurance", label: "Insurance" },
] as const;

export function isFinancialsPath(pathname: string) {
  return FINANCIALS_TABS.some(
    (tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`),
  );
}

export function FinancialsLayout() {
  const location = useLocation();
  const householdId = new URLSearchParams(location.search).get("household_id");
  return (
    <div>
      <nav
        aria-label="Financials"
        className="no-scrollbar mb-5 flex gap-1 overflow-x-auto border-b border-border/60"
      >
        {FINANCIALS_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={withHousehold(tab.to, householdId)}
            className={({ isActive }) =>
              cn(
                "-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
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
