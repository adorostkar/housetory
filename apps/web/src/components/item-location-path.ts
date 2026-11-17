import * as React from "react";

import { useSearchScopes, useSession } from "@/lib/queries";
import type { ItemListEntry, LocationBrief } from "@/lib/types";
import { CONTAINER_TYPE_LABELS, LOCATION_KIND_LABELS, locationLabel } from "@/lib/utils";

export interface ItemPathScope {
  singleHousehold: boolean;
  hasSingleProperty: (householdId: string | undefined) => boolean;
}

/**
 * Resolves which household/property names are redundant, from the cached
 * session. Search scopes (active properties only) are loaded just when a
 * membership count, which includes archived properties, is ambiguous.
 */
export function useItemPathScope(): ItemPathScope {
  const memberships = useSession().data?.households;
  const ambiguous = memberships?.some((entry) => entry.property_count > 1) ?? false;
  const scopes = useSearchScopes(ambiguous).data?.items;
  return React.useMemo(
    () => ({
      singleHousehold: memberships?.length === 1,
      hasSingleProperty: (householdId) => {
        const membership = householdId
          ? memberships?.find((entry) => entry.id === householdId)
          : memberships?.find((entry) => entry.is_current);
        if (!membership) return false;
        if (membership.property_count <= 1) return true;
        const active = scopes
          ?.find((entry) => entry.id === membership.id)
          ?.properties.filter((property) => !property.is_archived);
        return active !== undefined && active.length <= 1;
      },
    }),
    [memberships, scopes],
  );
}

function sameName(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function placeHint(place: LocationBrief) {
  if (place.identifier && !sameName(place.identifier, place.name)) return place.identifier;
  const label =
    place.is_container && place.container_type
      ? CONTAINER_TYPE_LABELS[place.container_type]
      : LOCATION_KIND_LABELS[place.kind];
  return place.kind === "room" || label === "Other" ? "storage place" : label.toLowerCase();
}

interface ItemPathSegment {
  key: string;
  text: string;
  place?: LocationBrief;
}

/**
 * `places` are the storage places a surface shows after the room. `full` is
 * always the complete household-to-place path; `segments` is the shortened one.
 */
export function itemLocationPath(
  item: Pick<ItemListEntry, "household" | "property" | "room" | "location" | "location_path">,
  scope: ItemPathScope,
  places: LocationBrief[],
): { full: string; short: string; segments: ItemPathSegment[] } {
  const allPlaces =
    item.location_path.length > 0 ? item.location_path : item.location ? [item.location] : [];
  const full = [
    item.household?.name,
    item.property?.name,
    item.room?.name,
    ...allPlaces.map((entry) => locationLabel(entry)),
  ]
    .filter(Boolean)
    .join(" / ");

  const segments: ItemPathSegment[] = [];
  if (item.household && !scope.singleHousehold) {
    segments.push({ key: "household", text: item.household.name });
  }
  if (
    item.property &&
    (item.property.is_archived || !scope.hasSingleProperty(item.household?.id))
  ) {
    segments.push({ key: "property", text: item.property.name });
  }
  const [first, ...rest] = places;
  if (item.room && first && sameName(item.room.name, first.name)) {
    // A place named like its room is shown once, with a hint that it is a
    // storage place inside that room rather than the room itself.
    segments.push({ key: first.id, text: `${item.room.name} · ${placeHint(first)}`, place: first });
  } else {
    if (item.room) segments.push({ key: "room", text: item.room.name });
    if (first) segments.push({ key: first.id, text: locationLabel(first), place: first });
  }
  for (const place of rest) {
    segments.push({ key: place.id, text: locationLabel(place), place });
  }
  return { full, short: segments.map((segment) => segment.text).join(" / "), segments };
}
