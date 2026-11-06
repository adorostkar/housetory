import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { useSearchScopes } from "@/lib/queries";
import type { SearchScopeHousehold } from "@/lib/types";

const STORAGE_KEY = "housetory-search-scope";

export interface SearchScopeSelection {
  householdId: string;
  propertyId: string;
}

function readStoredScope(): SearchScopeSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { householdId: "", propertyId: "" };
    const parsed = JSON.parse(raw) as Partial<SearchScopeSelection>;
    return {
      householdId: typeof parsed.householdId === "string" ? parsed.householdId : "",
      propertyId: typeof parsed.propertyId === "string" ? parsed.propertyId : "",
    };
  } catch {
    return { householdId: "", propertyId: "" };
  }
}

function writeStoredScope(selection: SearchScopeSelection) {
  try {
    if (selection.householdId) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Remembering a narrower search scope is best effort.
  }
}

export function scopeLabel(
  selection: SearchScopeSelection,
  scopes: SearchScopeHousehold[],
): string {
  if (!selection.householdId) return "All my places";
  const household = scopes.find((entry) => entry.id === selection.householdId);
  if (!household) return "All my places";
  if (!selection.propertyId) return household.name;
  const property = household.properties.find((entry) => entry.id === selection.propertyId);
  return property ? `${household.name} · ${property.name}` : household.name;
}

export function useSearchScope(syncUrl = true) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlHousehold = searchParams.get("household_id") ?? "";
  const urlProperty = searchParams.get("property_id") ?? "";
  const hasUrlScope =
    searchParams.has("household_id") || searchParams.has("property_id");
  const initializedUrl = React.useRef(false);
  const [selection, setSelectionState] = React.useState<SearchScopeSelection>(() => {
    const stored = readStoredScope();
    return {
      householdId: hasUrlScope ? urlHousehold : stored.householdId,
      propertyId: hasUrlScope ? urlProperty : stored.propertyId,
    };
  });
  const scopesQuery = useSearchScopes(
    syncUrl || Boolean(selection.householdId),
  );
  const scopes = scopesQuery.data?.items ?? [];

  const setSelection = React.useCallback(
    (next: SearchScopeSelection, options: { syncUrl?: boolean } = {}) => {
      setSelectionState(next);
      writeStoredScope(next);
      if (!syncUrl || options.syncUrl === false) return;
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (next.householdId) params.set("household_id", next.householdId);
          else params.delete("household_id");
          if (next.propertyId) params.set("property_id", next.propertyId);
          else params.delete("property_id");
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams, syncUrl],
  );

  // Keep sibling scope controls and the page using them in sync. Without this,
  // the selector would update only its own hook instance while the results
  // query kept the previous household scope.
  React.useEffect(() => {
    if (!syncUrl) return;
    if (!initializedUrl.current) {
      initializedUrl.current = true;
      if (!hasUrlScope && (selection.householdId || selection.propertyId)) {
        setSelection(selection);
      }
      return;
    }
    if (
      selection.householdId === urlHousehold &&
      selection.propertyId === urlProperty
    ) {
      return;
    }
    const next = { householdId: urlHousehold, propertyId: urlProperty };
    setSelectionState(next);
    writeStoredScope(next);
  }, [
    syncUrl,
    hasUrlScope,
    urlHousehold,
    urlProperty,
    selection,
    setSelection,
  ]);

  // Drop a remembered scope when a membership is revoked or a property is
  // archived/missing. This is client-side convenience; the API validates again.
  React.useEffect(() => {
    if (scopesQuery.isPending) return;
    if (!selection.householdId) {
      if (selection.propertyId) setSelection({ householdId: "", propertyId: "" });
      return;
    }
    const household = scopes.find((entry) => entry.id === selection.householdId);
    if (!household) {
      setSelection({ householdId: "", propertyId: "" });
      return;
    }
    if (
      selection.propertyId &&
      !household.properties.some((property) => property.id === selection.propertyId)
    ) {
      setSelection({ householdId: household.id, propertyId: "" });
    }
  }, [scopes, scopesQuery.isPending, selection, setSelection]);

  return {
    selection,
    setSelection,
    scopes,
    scopesQuery,
    label: scopeLabel(selection, scopes),
  };
}

export function useRememberedSearchScope() {
  return useSearchScope(false);
}
