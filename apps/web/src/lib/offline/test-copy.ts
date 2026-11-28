import type {
  Container,
  ItemDetail,
  Loan,
  OfflineCopy,
  Room,
  SessionState,
  StorageLocation,
} from "@/lib/types";

/*
 * A small household for tests of the offline copy:
 *
 *   Home
 *     Garage            (room)
 *       Top shelf       (fixed place)
 *         BOX-001 Tools (container)   Cordless drill ×2, one lent to Grace
 *     Kitchen           (room)        Kettle, Old kettle (archived)
 *   Cabin
 *     Shed              (room)        Axe
 */

const STAMP = "2026-11-01T10:00:00Z";
const HOME = { id: "home", name: "Home", is_archived: false };
const CABIN = { id: "cabin", name: "Cabin", is_archived: false };

function room(id: string, name: string, property = HOME): Room {
  return {
    id,
    name,
    description: null,
    property_id: property.id,
    property,
    parent_id: null,
    sort_order: 0,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

const SHELF: StorageLocation = {
  id: "shelf",
  room_id: "garage",
  parent_id: null,
  name: "Top shelf",
  description: null,
  kind: "shelf",
  is_container: false,
  container_type: null,
  identifier: null,
  label_generated_at: null,
  sort_order: 0,
  item_count: 0,
  total_item_count: 1,
  created_at: STAMP,
  updated_at: STAMP,
};
const BOX: StorageLocation = {
  ...SHELF,
  id: "box",
  parent_id: "shelf",
  name: "Tools",
  kind: "box",
  is_container: true,
  container_type: "box",
  identifier: "BOX-001",
  item_count: 1,
};

function container(location: StorageLocation, path: StorageLocation[]): Container {
  return {
    id: location.id,
    property: HOME,
    identifier: location.identifier,
    name: location.name,
    description: null,
    kind: location.kind,
    container_type: location.container_type,
    is_container: location.is_container,
    room_id: location.room_id,
    parent_id: location.parent_id,
    room: { id: "garage", name: "Garage" },
    path: path.map(({ id, name, kind, parent_id, identifier, container_type, is_container }) => ({
      id,
      name,
      kind,
      parent_id,
      identifier,
      container_type,
      is_container,
    })),
    item_count: location.item_count,
    total_item_count: 1,
    total_quantity: 2,
    child_count: location.id === "shelf" ? 1 : 0,
    container_count: 1,
    qr_payload: `http://housetory.test/containers/${location.id}`,
    qr_url: `/api/v1/containers/${location.id}/qr.svg`,
    qr_warning: null,
    label_generated_at: null,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

export function testItem(id: string, name: string, patch: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id,
    name,
    description: null,
    brand: null,
    model: null,
    quantity: 1,
    on_loan_quantity: 0,
    condition: "good",
    is_archived: false,
    room: null,
    property: null,
    location: null,
    location_path: [],
    category: null,
    tags: [],
    primary_photo: null,
    purchase: null,
    purchase_info_status: "unrecorded",
    purchase_info_missing_fields: [],
    warranty: null,
    current_value_cents: null,
    current_value_currency: "USD",
    current_value_basis: null,
    current_value_total_cents: null,
    current_value_estimated_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    serial_number: null,
    photos: [],
    documents: [],
    import_source: null,
    ...patch,
  };
}

const BOX_BRIEF = {
  id: "box",
  name: "Tools",
  kind: "box" as const,
  parent_id: "shelf",
  identifier: "BOX-001",
  container_type: "box" as const,
  is_container: true,
};
const SHELF_BRIEF = {
  id: "shelf",
  name: "Top shelf",
  kind: "shelf" as const,
  parent_id: null,
  identifier: null,
  container_type: null,
  is_container: false,
};

export const DRILL_LOAN: Loan = {
  id: "loan-1",
  item_id: "drill",
  item_name: "Cordless drill",
  item_name_snapshot: "Cordless drill",
  home_room_id: "garage",
  home_room_name_snapshot: "Garage",
  home_location_id: "box",
  home_location_name_snapshot: "Tools",
  home_location_identifier_snapshot: "BOX-001",
  borrower_name: "Grace",
  quantity: 1,
  returned_quantity: 0,
  outstanding_quantity: 1,
  status: "outstanding",
  lent_on: "2026-11-01",
  due_on: "2026-11-20",
  notes: null,
  overdue: false,
  days_past_due: null,
  latest_returned_on: null,
  created_by_user_id: "user-1",
  created_by_name: "Ada",
  cancelled_at: null,
  created_at: STAMP,
  updated_at: STAMP,
};

export const TEST_SESSION: SessionState = {
  authenticated: true,
  setup_required: false,
  user: { id: "user-1", name: "Ada", email: "ada@example.com", created_at: STAMP },
  household: {
    id: "household-1",
    name: "Ada's Home",
    default_currency: "USD",
    warranty_reminder_days: 30,
    offline_copy_policy: "members",
  },
  role: "owner",
  offline_copy_allowed: true,
  households: [],
};

export function testCopy(patch: Partial<OfflineCopy> = {}): OfflineCopy {
  const items = [
    testItem("drill", "Cordless drill", {
      brand: "Bosch",
      serial_number: "SN-42",
      quantity: 2,
      on_loan_quantity: 1,
      property: HOME,
      location: BOX_BRIEF,
      location_path: [SHELF_BRIEF, BOX_BRIEF],
      category: { id: "tools", name: "Tools", color: null },
      tags: [{ id: "power", name: "power" }],
      created_at: "2026-11-04T10:00:00Z",
    }),
    testItem("kettle", "Kettle", {
      room: { id: "kitchen", name: "Kitchen" },
      property: HOME,
      purchase_info_status: "recorded",
      created_at: "2026-11-03T10:00:00Z",
    }),
    testItem("old-kettle", "Old kettle", {
      room: { id: "kitchen", name: "Kitchen" },
      property: HOME,
      is_archived: true,
      created_at: "2026-11-02T10:00:00Z",
    }),
    testItem("axe", "Axe", {
      room: { id: "shed", name: "Shed" },
      property: CABIN,
      created_at: "2026-11-01T10:00:00Z",
    }),
  ];
  return {
    userId: "user-1",
    householdId: "household-1",
    savedAt: Date.now(),
    etag: '"v1"',
    session: TEST_SESSION,
    snapshot: {
      version: 1,
      generated_at: STAMP,
      user: TEST_SESSION.user!,
      household: TEST_SESSION.household!,
      role: "owner",
      properties: { items: [] },
      rooms: { items: [room("garage", "Garage"), room("kitchen", "Kitchen"), room("shed", "Shed", CABIN)] },
      locations: { items: [SHELF, BOX] },
      categories: { items: [] },
      tags: { items: [] },
      containers: {
        items: [container(BOX, [SHELF, BOX]), container(SHELF, [SHELF])],
        total: 2,
        qr_base_url: "http://housetory.test",
        qr_warning: null,
      },
      items,
      loans: {
        items: [DRILL_LOAN],
        total: 1,
        limit: 1_000_000,
        offset: 0,
        outstanding_count: 1,
        overdue_count: 0,
        on_loan_quantity: 1,
      },
      overview: { item_count: 3 } as OfflineCopy["snapshot"]["overview"],
    },
    ...patch,
  };
}
