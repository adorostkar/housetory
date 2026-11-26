import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { setStoredPropertyId, useStoredPropertyId } from "@/lib/property-filter-store";
import { useProperties } from "@/lib/queries";
import type { Property } from "@/lib/types";

export function usePropertyFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const propertiesQuery = useProperties();
  // A property in the link wins over the remembered one when the page opens.
  React.useState(() => {
    const linked = searchParams.get("property_id");
    if (linked) setStoredPropertyId(linked, false);
    return null;
  });
  const propertyId = useStoredPropertyId();

  const setPropertyId = React.useCallback(
    (value: string) => {
      setStoredPropertyId(value);
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
