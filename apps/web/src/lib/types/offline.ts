import type { ContainerList } from "@/lib/types/containers";
import type { MemberRole } from "@/lib/types/core";
import type { Household, SessionState, User } from "@/lib/types/households";
import type { ItemDetail, Overview } from "@/lib/types/items";
import type { LoanList } from "@/lib/types/loans";
import type {
  CategoryList,
  PropertyList,
  RoomList,
  StorageLocationList,
  TagList,
} from "@/lib/types/places";

/** Who in a household may keep a read-only copy of the inventory on a device. */
export type OfflineCopyPolicy = "nobody" | "members" | "everyone";

/** One household as the server sends it for the offline copy. */
export interface OfflineSnapshot {
  version: number;
  generated_at: string;
  user: User;
  household: Household;
  role: MemberRole;
  properties: PropertyList;
  rooms: RoomList;
  locations: StorageLocationList;
  categories: CategoryList;
  tags: TagList;
  containers: ContainerList;
  items: ItemDetail[];
  loans: LoanList;
  overview: Overview;
}

/** The copy kept on this device: the snapshot and the session it belongs to. */
export interface OfflineCopy {
  userId: string;
  householdId: string;
  /** When the server was last asked, in milliseconds. */
  savedAt: number;
  etag: string | null;
  session: SessionState;
  snapshot: OfflineSnapshot;
}
