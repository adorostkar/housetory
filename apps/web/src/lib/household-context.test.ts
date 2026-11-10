import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveHouseholdId,
  householdScopedQueryHash,
  setActiveHouseholdId,
} from "@/lib/api";
import { applyHouseholdSession, queryKeys } from "@/lib/queries";
import type { SessionState } from "@/lib/types";

const previous: SessionState = {
  authenticated: true,
  setup_required: false,
  user: null,
  household: { id: "home-1", name: "Home", default_currency: "USD", warranty_reminder_days: 30 },
  role: "owner",
  households: [],
};

const next: SessionState = {
  ...previous,
  household: { id: "home-2", name: "Cabin", default_currency: "USD", warranty_reminder_days: 30 },
  role: "viewer",
  households: [
    {
      id: "home-2",
      name: "Cabin",
      default_currency: "USD", warranty_reminder_days: 30,
      role: "viewer",
      property_count: 1,
      is_current: true,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  setActiveHouseholdId(null);
});

describe("household query isolation", () => {
  it("reuses the session fetched before the household is known", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { queryKeyHashFn: householdScopedQueryHash, staleTime: 30_000 },
      },
    });
    const queryFn = vi.fn(async () => previous);
    await client.fetchQuery({ queryKey: queryKeys.session, queryFn });
    setActiveHouseholdId("home-1");
    expect(await client.fetchQuery({ queryKey: queryKeys.session, queryFn })).toEqual(previous);
    expect(queryFn).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("hashes the same logical query differently per household", () => {
    setActiveHouseholdId("home-1");
    const first = householdScopedQueryHash(["items", { q: "drill" }]);
    setActiveHouseholdId("home-2");
    const second = householdScopedQueryHash(["items", { q: "drill" }]);
    expect(first).not.toBe(second);
    expect(getActiveHouseholdId()).toBe("home-2");
  });

  it("clears old caches, remembered filters and sets the new session", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.session, previous);
    client.setQueryData(queryKeys.overview, { item_count: 9 });
    client.setQueryData(queryKeys.items, { pages: [] });
    window.localStorage.setItem("housetory-property-filter", "property-old");
    window.localStorage.setItem(
      "housetory-search-scope",
      JSON.stringify({ householdId: "home-1", propertyId: "property-old" }),
    );

    applyHouseholdSession(client, next);

    expect(client.getQueryData(queryKeys.session)).toEqual(next);
    expect(client.getQueryData(queryKeys.overview)).toBeUndefined();
    expect(client.getQueryData(queryKeys.items)).toBeUndefined();
    expect(window.localStorage.getItem("housetory-property-filter")).toBeNull();
    expect(window.localStorage.getItem("housetory-search-scope")).toBeNull();
    expect(getActiveHouseholdId()).toBe("home-2");
  });
});
