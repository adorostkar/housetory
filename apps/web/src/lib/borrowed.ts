import type { BorrowedRecord } from "@/lib/types";

type BorrowedStock = Pick<
  BorrowedRecord,
  "status" | "outstanding_quantity" | "physically_held_quantity"
>;

type BorrowedPlace = Pick<
  BorrowedRecord,
  "property_name" | "room_name" | "storage_location_name"
>;

export function borrowedHasHeldStock(record: BorrowedStock): boolean {
  return (
    (record.status === "outstanding" || record.status === "partially_returned") &&
    record.physically_held_quantity > 0
  );
}

export function borrowedLocationPrefix(record: BorrowedStock): string {
  if (borrowedHasHeldStock(record)) return "kept at";
  return record.status === "returned"
    ? "previously kept at"
    : "last recorded location";
}

export function borrowedLocationHeading(record: BorrowedStock): string {
  if (borrowedHasHeldStock(record)) return "Kept at";
  return record.status === "returned"
    ? "Previously kept at"
    : "Last recorded location";
}

export function borrowedPlaceLabel(record: BorrowedPlace): string {
  return (
    [record.property_name, record.room_name, record.storage_location_name]
      .filter(Boolean)
      .join(" / ") || "no place recorded"
  );
}

export function borrowedWhereLabel(
  record: BorrowedStock & BorrowedPlace,
): string {
  return `${borrowedLocationPrefix(record)} ${borrowedPlaceLabel(record)}`;
}
