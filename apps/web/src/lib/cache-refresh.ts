import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import * as React from "react";

import { queryKeys } from "@/lib/query-keys";

/*
 * Named cache refreshes, one per kind of change. Each lists every query family
 * whose data that change can alter, including counts shown elsewhere (items per
 * room, per storage place and per container). Call the one that matches what
 * the mutation did instead of listing keys at the call site.
 */

// Item records and everything that counts or lists them.
const ITEM_KEYS: QueryKey[] = [
  queryKeys.items,
  queryKeys.itemAll,
  queryKeys.rooms,
  queryKeys.locationsAll,
  queryKeys.containers,
  queryKeys.overview,
  queryKeys.search,
];

// Rooms, storage places and containers, and the items placed in them.
const PLACE_KEYS: QueryKey[] = [
  queryKeys.rooms,
  queryKeys.properties,
  queryKeys.locationsAll,
  queryKeys.containers,
  queryKeys.photos,
  queryKeys.items,
  queryKeys.itemAll,
  queryKeys.overview,
  queryKeys.search,
  queryKeys.stocktake,
  queryKeys.placeTransferPreviewAll,
];

// Loans and borrowed records, and the at-home quantities they change.
const LOAN_KEYS: QueryKey[] = [
  queryKeys.loans,
  queryKeys.borrowed,
  queryKeys.items,
  queryKeys.itemAll,
  queryKeys.rooms,
  queryKeys.locationsAll,
  queryKeys.containers,
  queryKeys.overview,
  queryKeys.search,
];

function refresh(client: QueryClient, keys: QueryKey[]) {
  const seen = new Set<string>();
  for (const queryKey of keys) {
    const id = JSON.stringify(queryKey);
    if (seen.has(id)) continue;
    seen.add(id);
    void client.invalidateQueries({ queryKey });
  }
}

/** Items were created, edited, moved, archived or deleted. */
export function onItemsChanged(client: QueryClient) {
  refresh(client, ITEM_KEYS);
}

/** Rooms, storage places or containers were created, edited, moved or deleted. */
export function onPlacesChanged(client: QueryClient) {
  refresh(client, PLACE_KEYS);
}

/** Items or containers were moved between rooms, storage places or properties. */
export function onItemsMoved(client: QueryClient) {
  refresh(client, [...ITEM_KEYS, ...PLACE_KEYS, queryKeys.loans]);
}

/** A loan or borrowed record was created, returned, corrected or cancelled. */
export function onLoansChanged(client: QueryClient) {
  refresh(client, LOAN_KEYS);
}

/** A history entry was undone or restored; it may have been a move, a loan or a return. */
export function onUndo(client: QueryClient) {
  refresh(client, [...ITEM_KEYS, ...PLACE_KEYS, ...LOAN_KEYS]);
}

export function useCacheRefresh() {
  const client = useQueryClient();
  return React.useMemo(() => ({
    onItemsChanged: () => onItemsChanged(client),
    onPlacesChanged: () => onPlacesChanged(client),
    onItemsMoved: () => onItemsMoved(client),
    onLoansChanged: () => onLoansChanged(client),
    onUndo: () => onUndo(client),
  }), [client]);
}
