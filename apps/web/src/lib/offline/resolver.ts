import { ApiError } from "@/lib/api";
import type {
  Container,
  ContainerChild,
  ContainerDetail,
  ItemDetail,
  ItemLoanSummary,
  Loan,
  LoanList,
  OfflineCopy,
  QuickSearchResponse,
  QuickSearchResult,
  Room,
  StorageLocation,
} from "@/lib/types";
import { localDateISO } from "@/lib/utils";

/*
 * Answers the app's normal read requests from the copy kept on the device.
 * Each answer has the shape of the server route it stands in for, so pages work
 * unchanged. Lists are filtered and sorted here the way the server does it.
 * What the copy does not hold is refused with `offline_unavailable`.
 */

export const OFFLINE_UNAVAILABLE = "offline_unavailable";
export const OFFLINE_READ_ONLY = "offline_read_only";

export function offlineUnavailable(): ApiError {
  return new ApiError(
    0,
    OFFLINE_UNAVAILABLE,
    "This is not in your offline copy. It needs a connection to your Housetory server.",
  );
}

export function offlineReadOnly(): ApiError {
  return new ApiError(
    0,
    OFFLINE_READ_ONLY,
    "You are offline. Changes need a connection to your Housetory server.",
  );
}

function notFound(what: string): ApiError {
  return new ApiError(404, "not_found", `${what} is not in your offline copy.`);
}

type Tree = Array<{ id: string; parent_id: string | null }>;

/** The id itself and every id below it. */
function withDescendants(rows: Tree, rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_id) continue;
    const list = children.get(row.parent_id);
    if (list) list.push(row.id);
    else children.set(row.parent_id, [row.id]);
  }
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as string) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

function contains(value: string | null | undefined, needle: string): boolean {
  return Boolean(value) && (value as string).toLowerCase().includes(needle);
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  // Missing values come last, as the server sorts them.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRaw(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function flag(params: URLSearchParams, name: string): boolean {
  return params.get(name) === "true";
}

function page<T>(rows: T[], params: URLSearchParams, defaultLimit: number) {
  const limit = Math.max(1, Number(params.get("limit")) || defaultLimit);
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

/** Items whose own fields, room or storage place match the search text. */
function itemMatcher(copy: OfflineCopy, term: string): (item: ItemDetail) => boolean {
  const needle = term.toLowerCase();
  const { rooms, locations } = copy.snapshot;
  const roomIds = new Set<string>();
  for (const room of rooms.items) {
    if (!contains(room.name, needle)) continue;
    for (const id of withDescendants(rooms.items, room.id)) roomIds.add(id);
  }
  const locationIds = new Set<string>();
  for (const location of locations.items) {
    if (!contains(location.name, needle) && !contains(location.identifier, needle)) continue;
    for (const id of withDescendants(locations.items, location.id)) locationIds.add(id);
  }
  return (item) =>
    contains(item.name, needle) ||
    contains(item.description, needle) ||
    contains(item.brand, needle) ||
    contains(item.model, needle) ||
    contains(item.serial_number, needle) ||
    contains(item.category?.name, needle) ||
    item.tags.some((tag) => contains(tag.name, needle)) ||
    (item.room !== null && roomIds.has(item.room.id)) ||
    (item.location !== null && locationIds.has(item.location.id));
}

function purchaseInfoMatches(item: ItemDetail, filter: string): boolean {
  const status = item.purchase_info_status;
  switch (filter) {
    case "missing":
      return status === "unrecorded" || status === "unknown";
    case "unknown":
    case "not_applicable":
    case "recorded":
      return status === filter;
    case "missing_date":
      return status !== "not_applicable" && item.purchase != null && !item.purchase.purchase_date;
    case "missing_price":
      return (
        status !== "not_applicable" && item.purchase != null && item.purchase.price_cents == null
      );
    default:
      return true;
  }
}

function nameRank(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return 3;
}

function listItems(copy: OfflineCopy, params: URLSearchParams) {
  const { rooms, locations } = copy.snapshot;
  const descendants = flag(params, "include_descendants");
  let rows = copy.snapshot.items;
  if (!flag(params, "include_archived")) rows = rows.filter((item) => !item.is_archived);

  const propertyId = params.get("property_id");
  if (propertyId) rows = rows.filter((item) => item.property?.id === propertyId);
  const roomId = params.get("room_id");
  if (roomId) {
    const ids = descendants ? withDescendants(rooms.items, roomId) : new Set([roomId]);
    rows = rows.filter((item) => item.room !== null && ids.has(item.room.id));
  }
  const locationId = params.get("location_id");
  if (locationId) {
    const ids = descendants ? withDescendants(locations.items, locationId) : new Set([locationId]);
    rows = rows.filter((item) => item.location !== null && ids.has(item.location.id));
  }
  const categoryId = params.get("category_id");
  if (categoryId) rows = rows.filter((item) => item.category?.id === categoryId);
  const tagId = params.get("tag_id");
  if (tagId) rows = rows.filter((item) => item.tags.some((tag) => tag.id === tagId));
  const purchaseInfo = params.get("purchase_info");
  if (purchaseInfo) rows = rows.filter((item) => purchaseInfoMatches(item, purchaseInfo));
  const ids = params.getAll("ids");
  if (ids.length > 0) {
    const wanted = new Set(ids);
    rows = rows.filter((item) => wanted.has(item.id));
  }
  const term = (params.get("q") ?? "").trim();
  if (term) rows = rows.filter(itemMatcher(copy, term));

  const roomsById = new Map(rooms.items.map((room) => [room.id, room]));
  const locationsById = new Map(locations.items.map((location) => [location.id, location]));
  const placeRoom = (item: ItemDetail): Room | undefined => {
    if (item.room) return roomsById.get(item.room.id);
    const location = item.location ? locationsById.get(item.location.id) : undefined;
    return location ? roomsById.get(location.room_id) : undefined;
  };
  const sort = params.get("sort") ?? "created_desc";
  const newestFirst = (a: ItemDetail, b: ItemDetail) => compareRaw(b.created_at, a.created_at);
  const order: Record<string, (a: ItemDetail, b: ItemDetail) => number> = {
    created_desc: newestFirst,
    created_asc: (a, b) => compareRaw(a.created_at, b.created_at),
    name_asc: (a, b) => compareText(a.name, b.name),
    name_desc: (a, b) => compareText(b.name, a.name),
    updated_desc: (a, b) => compareRaw(b.updated_at, a.updated_at),
    // Property, room, storage place, then name. Items without a place come last.
    location_asc: (a, b) =>
      compareText(a.property?.name, b.property?.name) ||
      compareText(placeRoom(a)?.name, placeRoom(b)?.name) ||
      compareText(a.location?.name, b.location?.name) ||
      compareText(a.name, b.name),
  };
  const chosen = order[sort] ?? newestFirst;
  const needle = term.toLowerCase();
  const sorted = [...rows].sort(
    (a, b) =>
      (term ? nameRank(a.name, needle) - nameRank(b.name, needle) : 0) ||
      chosen(a, b) ||
      compareRaw(a.id, b.id),
  );
  return page(sorted, params, 30);
}

function findItem(copy: OfflineCopy, itemId: string): ItemDetail {
  const item = copy.snapshot.items.find((entry) => entry.id === itemId);
  if (!item) throw notFound("This item");
  return item;
}

function onDate(params: URLSearchParams, now: Date): string {
  return params.get("on_date") || localDateISO(now);
}

/** A loan as it stands on the given day; the copy may be older than today. */
function loanOn(loan: Loan, today: string): Loan {
  const overdue = loan.due_on !== null && loan.due_on < today;
  const days = overdue
    ? Math.round((Date.parse(today) - Date.parse(loan.due_on as string)) / 86_400_000)
    : null;
  return { ...loan, overdue, days_past_due: days };
}

function listLoans(copy: OfflineCopy, params: URLSearchParams, now: Date): LoanList {
  const status = params.get("status") ?? "open";
  // The copy holds loans that are still out. Returned and cancelled ones stay on the server.
  if (status !== "open" && status !== "outstanding" && status !== "partially_returned") {
    throw offlineUnavailable();
  }
  const today = onDate(params, now);
  const open = copy.snapshot.loans.items.map((loan) => loanOn(loan, today));
  const itemId = params.get("item_id");
  const inScope = itemId ? open.filter((loan) => loan.item_id === itemId) : open;
  let rows = inScope;
  if (status !== "open") rows = rows.filter((loan) => loan.status === status);
  const term = (params.get("q") ?? "").trim().toLowerCase();
  if (term) {
    rows = rows.filter(
      (loan) => contains(loan.item_name, term) || contains(loan.borrower_name, term),
    );
  }
  const person = (params.get("person") ?? "").trim().toLowerCase();
  if (person) rows = rows.filter((loan) => loan.borrower_name.toLowerCase() === person);
  if (flag(params, "overdue")) rows = rows.filter((loan) => loan.overdue);
  return {
    ...page(rows, params, 50),
    outstanding_count: inScope.length,
    overdue_count: inScope.filter((loan) => loan.overdue).length,
    on_loan_quantity: inScope.reduce((sum, loan) => sum + loan.outstanding_quantity, 0),
  };
}

function itemLoans(copy: OfflineCopy, itemId: string, today: string): ItemLoanSummary {
  const item = findItem(copy, itemId);
  const loans = copy.snapshot.loans.items
    .filter((loan) => loan.item_id === itemId)
    .map((loan) => loanOn(loan, today))
    .sort(
      (a, b) => compareText(a.due_on, b.due_on) || compareRaw(a.created_at, b.created_at),
    );
  const onLoan = loans.reduce((sum, loan) => sum + loan.outstanding_quantity, 0);
  return {
    item_id: item.id,
    item_name: item.name,
    owned_quantity: item.quantity,
    on_loan_quantity: onLoan,
    available_quantity: Math.max(0, item.quantity - onLoan),
    outstanding_loan_count: loans.length,
    overdue_count: loans.filter((loan) => loan.overdue).length,
    loans,
  };
}

function listContainers(copy: OfflineCopy, params: URLSearchParams) {
  const all = copy.snapshot.containers;
  let rows = all.items;
  if (!flag(params, "include_fixed")) rows = rows.filter((entry) => entry.is_container);
  if (!flag(params, "include_owned")) rows = rows.filter((entry) => !entry.owner_item);
  const propertyId = params.get("property_id");
  if (propertyId) rows = rows.filter((entry) => entry.property?.id === propertyId);
  const roomId = params.get("room_id");
  if (roomId) rows = rows.filter((entry) => entry.room_id === roomId);
  const type = params.get("container_type");
  if (type) rows = rows.filter((entry) => entry.container_type === type);
  const term = (params.get("q") ?? "").trim().toLowerCase();
  if (term) {
    rows = rows.filter((entry) => contains(entry.identifier, term) || contains(entry.name, term));
  }
  const empty = params.get("empty");
  if (empty !== null) {
    rows = rows.filter((entry) => (entry.total_item_count === 0) === (empty === "true"));
  }
  const { items, total } = page(rows, params, 100);
  return { items, total, qr_base_url: all.qr_base_url, qr_warning: all.qr_warning };
}

function roomTrail(rooms: Room[], roomId: string | null | undefined): Room[] {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const trail: Room[] = [];
  const seen = new Set<string>();
  let cursor = roomId ? byId.get(roomId) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    trail.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return trail;
}

function containerDetail(copy: OfflineCopy, containerId: string): ContainerDetail {
  const { containers, locations, rooms } = copy.snapshot;
  const container = containers.items.find((entry) => entry.id === containerId);
  if (!container) throw notFound("This storage place");
  const live = copy.snapshot.items.filter((item) => !item.is_archived && item.location !== null);
  const inside = (rootId: string) => {
    const ids = withDescendants(locations.items, rootId);
    return live.filter((item) => ids.has((item.location as { id: string }).id));
  };
  const items = inside(containerId).sort((a, b) => compareText(a.name, b.name));
  const direct = items.filter((item) => item.location?.id === containerId);
  const quantity = (rows: ItemDetail[]) => rows.reduce((sum, item) => sum + item.quantity, 0);

  const byContainerId = new Map(containers.items.map((entry) => [entry.id, entry]));
  const children: ContainerChild[] = locations.items
    .filter((location) => location.parent_id === containerId)
    .sort((a, b) => a.sort_order - b.sort_order || compareText(a.name, b.name))
    .map((child: StorageLocation) => {
      const nested = inside(child.id);
      const listed: Container | undefined = byContainerId.get(child.id);
      return {
        id: child.id,
        identifier: child.identifier,
        legacy_identifier: listed?.legacy_identifier ?? null,
        aliases: listed?.aliases ?? [],
        name: child.name,
        kind: child.kind,
        container_type: child.container_type,
        is_container: child.is_container,
        room_id: child.room_id,
        parent_id: child.parent_id,
        item_count: nested.filter((item) => item.location?.id === child.id).length,
        total_item_count: nested.length,
        total_quantity: quantity(nested),
        child_count: locations.items.filter((entry) => entry.parent_id === child.id).length,
      };
    });

  const categories = new Map<string, { item_count: number; total_quantity: number }>();
  for (const item of items) {
    const name = item.category?.name ?? "Uncategorised";
    const entry = categories.get(name) ?? { item_count: 0, total_quantity: 0 };
    entry.item_count += 1;
    entry.total_quantity += item.quantity;
    categories.set(name, entry);
  }
  return {
    ...container,
    room_path: roomTrail(rooms.items, container.room_id).map(({ id, name }) => ({ id, name })),
    items,
    children,
    // Documents cannot be opened offline, so none are listed for the place.
    documents: [],
    summary: {
      item_count: items.length,
      total_quantity: quantity(items),
      direct_item_count: direct.length,
      direct_total_quantity: quantity(direct),
      empty: items.length === 0,
      categories: [...categories.entries()]
        .map(([name, counts]) => ({ name, ...counts }))
        .sort((a, b) => b.total_quantity - a.total_quantity || compareText(a.name, b.name)),
      label_generated_at: container.label_generated_at,
    },
    owner_item_detail: container.owner_item
      ? (copy.snapshot.items.find((item) => item.id === container.owner_item?.id) ?? null)
      : null,
  };
}

function placeContext(
  copy: OfflineCopy,
  roomId: string | null | undefined,
  path: Array<{ name: string; identifier?: string | null }>,
): string | null {
  const trail = roomTrail(copy.snapshot.rooms.items, roomId);
  const parts = trail.map((room) => room.name);
  const propertyName = trail.at(-1)?.property?.name;
  if (propertyName) parts.unshift(propertyName);
  for (const entry of path) {
    const label =
      entry.identifier && entry.identifier !== entry.name
        ? `${entry.identifier} · ${entry.name}`
        : entry.identifier || entry.name;
    if (label && !parts.includes(label)) parts.push(label);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function quickSearch(copy: OfflineCopy, params: URLSearchParams, now: Date): QuickSearchResponse {
  const term = (params.get("q") ?? "").trim();
  const limit = Math.max(1, Number(params.get("limit")) || 4);
  const { household, containers, locations } = copy.snapshot;
  const propertyId = params.get("property_id");
  const scope = { id: household.id, name: household.name, role: copy.snapshot.role };
  const base: QuickSearchResponse = {
    query: term,
    effective_query: null,
    question_like: false,
    results: [],
    scope_label: household.name,
    households: [scope],
    property: null,
    notices: ["Offline: results come from the copy on this device."],
  };
  const otherHousehold = params.get("household_id");
  if (term.length < 2 || (otherHousehold && otherHousehold !== household.id)) return base;

  const needle = term.toLowerCase();
  const today = localDateISO(now);
  const matches = itemMatcher(copy, term);
  const items: QuickSearchResult[] = copy.snapshot.items
    .filter(
      (item) =>
        !item.is_archived && (!propertyId || item.property?.id === propertyId) && matches(item),
    )
    .sort((a, b) => compareText(a.name, b.name))
    .slice(0, limit)
    .map((item) => {
      const loans = itemLoans(copy, item.id, today);
      const dueDates = loans.loans.map((loan) => loan.due_on).filter(Boolean) as string[];
      const subtitle = [
        item.brand,
        item.model,
        item.serial_number ? `Serial ${item.serial_number}` : null,
      ].filter(Boolean);
      return {
        id: item.id,
        kind: "item" as const,
        title: item.name,
        subtitle: subtitle.length > 0 ? subtitle.join(" · ") : (item.category?.name ?? null),
        context: placeContext(
          copy,
          item.room?.id ?? locations.items.find((entry) => entry.id === item.location?.id)?.room_id,
          item.location_path,
        ),
        url: `/items/${item.id}`,
        household: scope,
        loan:
          loans.on_loan_quantity > 0
            ? {
                on_loan_quantity: loans.on_loan_quantity,
                borrower_names: [...new Set(loans.loans.map((loan) => loan.borrower_name))],
                next_due_on: dueDates.sort()[0] ?? null,
              }
            : null,
      };
    });

  const places = containers.items.filter(
    (place) =>
      (!propertyId || place.property?.id === propertyId) &&
      (contains(place.name, needle) ||
        contains(place.identifier, needle) ||
        contains(place.legacy_identifier, needle) ||
        (place.aliases ?? []).some((alias) => contains(alias, needle))),
  );
  const boxes: QuickSearchResult[] = places
    .filter((place) => place.is_container)
    .slice(0, limit)
    .map((place) => {
      const title = place.identifier || place.name;
      const other = [place.name, place.legacy_identifier, ...(place.aliases ?? [])].filter(
        (value, index, all): value is string =>
          Boolean(value) && value !== title && all.indexOf(value) === index,
      );
      return {
        id: place.id,
        kind: "container" as const,
        title,
        subtitle: other.slice(0, 3).join(" · ") || place.container_type || "container",
        context: placeContext(copy, place.room_id, place.path.slice(0, -1)),
        url: `/containers/${place.id}`,
        household: scope,
        loan: null,
      };
    });
  const fixed: QuickSearchResult[] = places
    .filter((place) => !place.is_container)
    .sort((a, b) => compareText(a.name, b.name))
    .slice(0, limit)
    .map((place) => ({
      id: place.id,
      kind: "location" as const,
      title: place.name,
      subtitle: place.identifier || place.kind.replace(/[_-]+/g, " "),
      context: placeContext(copy, place.room_id, place.path.slice(0, -1)),
      url: `/rooms/${place.room_id}?location_id=${place.id}`,
      household: scope,
      loan: null,
    }));
  return { ...base, results: [...items, ...boxes, ...fixed] };
}

/**
 * The answer to a read request, taken from the copy. `path` is the API path
 * with its query, without the `/api/v1` prefix.
 */
export function answerOffline(copy: OfflineCopy, path: string, now = new Date()): unknown {
  const url = new URL(path, "http://offline.invalid");
  const params = url.searchParams;
  const { snapshot } = copy;
  const segments = url.pathname.split("/").filter(Boolean);
  const [first, second, third] = segments;
  const depth = segments.length;

  if (url.pathname === "/auth/session") return copy.session;
  if (url.pathname === "/household") return snapshot.household;
  if (url.pathname === "/households") return { items: copy.session.households ?? [] };
  if (url.pathname === "/overview") return { ...snapshot.overview, financial: null };
  if (url.pathname === "/categories") return snapshot.categories;
  if (url.pathname === "/tags") return snapshot.tags;
  if (url.pathname === "/search/quick") return quickSearch(copy, params, now);
  if (url.pathname === "/search/scopes") {
    return {
      items: [
        {
          id: snapshot.household.id,
          name: snapshot.household.name,
          role: snapshot.role,
          properties: snapshot.properties.items.map(({ id, name, is_archived }) => ({
            id,
            name,
            is_archived,
          })),
        },
      ],
    };
  }

  if (first === "properties" && depth === 1) {
    return {
      items: snapshot.properties.items.filter(
        (property) => flag(params, "include_archived") || !property.is_archived,
      ),
    };
  }
  if (first === "rooms" && depth === 1) {
    const propertyId = params.get("property_id");
    return {
      items: snapshot.rooms.items.filter((room) => !propertyId || room.property_id === propertyId),
    };
  }
  if (first === "storage-locations" && depth === 1) {
    const roomId = params.get("room_id");
    const term = (params.get("q") ?? "").trim().toLowerCase();
    const isContainer = params.get("is_container");
    return {
      items: snapshot.locations.items.filter(
        (location) =>
          (!roomId || location.room_id === roomId) &&
          (isContainer === null || location.is_container === (isContainer === "true")) &&
          (!term || contains(location.name, term) || contains(location.identifier, term)),
      ),
    };
  }
  if (first === "storage-locations" && depth === 2) {
    const location = snapshot.locations.items.find((entry) => entry.id === second);
    if (!location) throw notFound("This storage place");
    return location;
  }

  if (first === "items" && depth === 1) return listItems(copy, params);
  if (first === "items" && depth === 2) return { item: findItem(copy, second as string) };
  if (first === "items" && depth === 3 && third === "loans") {
    return itemLoans(copy, second as string, onDate(params, now));
  }
  if (first === "items" && depth === 3 && third === "photos") {
    return { items: findItem(copy, second as string).photos };
  }

  if (first === "containers" && depth === 1) return listContainers(copy, params);
  if (first === "containers" && depth === 2) return containerDetail(copy, second as string);

  if (first === "loans" && depth === 1) return listLoans(copy, params, now);

  throw offlineUnavailable();
}
