import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Field } from "@/components/form-field";
import { Select } from "@/components/ui/select";
import { queryKeys, useLocations, useProperties, useRooms } from "@/lib/queries";
import type { BorrowedRecord } from "@/lib/types";

export function useRequestId(open: boolean) {
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  React.useEffect(() => {
    if (open) setRequestId(crypto.randomUUID());
  }, [open]);
  return requestId;
}

export function invalidateBorrowed(
  client: ReturnType<typeof useQueryClient>,
  recordId?: string,
) {
  void client.invalidateQueries({ queryKey: queryKeys.borrowed });
  void client.invalidateQueries({ queryKey: ["loans"] });
  void client.invalidateQueries({ queryKey: ["search"] });
  if (recordId) {
    void client.invalidateQueries({ queryKey: queryKeys.borrowedRecord(recordId) });
  }
}

export function KeepingPlaceFields({
  propertyId,
  roomId,
  locationId,
  onPropertyChange,
  onRoomChange,
  onLocationChange,
}: {
  propertyId: string;
  roomId: string;
  locationId: string;
  onPropertyChange: (value: string) => void;
  onRoomChange: (value: string) => void;
  onLocationChange: (value: string) => void;
}) {
  const properties = useProperties();
  const rooms = useRooms(propertyId || undefined);
  const locations = useLocations(roomId || undefined);
  const roomRows = (rooms.data?.items ?? []).filter(
    (room) => !propertyId || room.property_id === propertyId,
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Keeping property" htmlFor="borrowed-property" optional>
        <Select
          id="borrowed-property"
          value={propertyId}
          onChange={(event) => onPropertyChange(event.target.value)}
        >
          <option value="">No property recorded</option>
          {(properties.data?.items ?? []).map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Keeping room" htmlFor="borrowed-room" optional>
        <Select
          id="borrowed-room"
          value={roomId}
          onChange={(event) => onRoomChange(event.target.value)}
        >
          <option value="">No room recorded</option>
          {roomRows.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Container or place" htmlFor="borrowed-location" optional className="sm:col-span-2">
        <Select
          id="borrowed-location"
          value={locationId}
          onChange={(event) => onLocationChange(event.target.value)}
          disabled={!roomId}
        >
          <option value="">No container recorded</option>
          {(locations.data?.items ?? []).map((location) => (
            <option key={location.id} value={location.id}>
              {location.identifier
                ? `${location.identifier} · ${location.name}`
                : location.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function useKeepingPlace(open: boolean, record?: BorrowedRecord | null) {
  const [propertyId, setPropertyId] = React.useState(record?.property_id ?? "");
  const [roomId, setRoomId] = React.useState(record?.room_id ?? "");
  const [locationId, setLocationId] = React.useState(record?.storage_location_id ?? "");
  React.useEffect(() => {
    if (!open) return;
    setPropertyId(record?.property_id ?? "");
    setRoomId(record?.room_id ?? "");
    setLocationId(record?.storage_location_id ?? "");
  }, [open, record?.id, record?.property_id, record?.room_id, record?.storage_location_id]);
  return {
    propertyId,
    roomId,
    locationId,
    setPropertyId: (value: string) => {
      setPropertyId(value);
      setRoomId("");
      setLocationId("");
    },
    setRoomId: (value: string) => {
      setRoomId(value);
      setLocationId("");
    },
    setLocationId,
  };
}
