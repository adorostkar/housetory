import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { useProperties } from "@/lib/queries";
import type { Property } from "@/lib/types";

const STORAGE_KEY = "housetory-property-filter";

function storedPropertyId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function usePropertyFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const propertiesQuery = useProperties();
  const [propertyId, setPropertyIdState] = React.useState(
    () => searchParams.get("property_id") ?? storedPropertyId(),
  );

  const setPropertyId = React.useCallback(
    (value: string) => {
      setPropertyIdState(value);
      try {
        if (value) window.localStorage.setItem(STORAGE_KEY, value);
        else window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Remembering the filter is best effort.
      }
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value) next.set("property_id", value);
          else next.delete("property_id");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const properties = propertiesQuery.data?.items ?? [];
  React.useEffect(() => {
    if (!propertyId || propertiesQuery.isPending) return;
    if (!properties.some((property) => property.id === propertyId)) {
      setPropertyId("");
    }
  }, [propertyId, properties, propertiesQuery.isPending, setPropertyId]);

  const selectedProperty: Property | undefined = properties.find(
    (property) => property.id === propertyId,
  );
  return {
    propertyId,
    setPropertyId,
    properties,
    selectedProperty,
    propertiesQuery,
  };
}
