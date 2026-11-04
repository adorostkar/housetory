import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { ItemCondition, LocationKind, Room } from "@/lib/types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCurrency(
  cents: number,
  currency = "USD",
  options: { compact?: boolean } = {},
): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: options.compact ? "compact" : "standard",
      maximumFractionDigits: options.compact ? 1 : Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = parseDateOnly(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function parseDateOnly(value: string): Date | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return formatDate(value);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return `${first}${last}`.toUpperCase() || "H";
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export const CONDITION_LABELS: Record<ItemCondition, string> = {
  new: "New",
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  unknown: "Unknown",
};

export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  room: "Room",
  closet: "Closet",
  cabinet: "Cabinet",
  shelf: "Shelf",
  drawer: "Drawer",
  box: "Box",
  bin: "Bin",
  other: "Other",
};

export interface RoomNode extends Room {
  children: RoomNode[];
}

export function buildRoomTree(rooms: Room[]): RoomNode[] {
  const byId = new Map<string, RoomNode>();
  for (const room of rooms) {
    byId.set(room.id, { ...room, children: [] });
  }
  const roots: RoomNode[] = [];
  for (const room of rooms) {
    const node = byId.get(room.id);
    if (!node) continue;
    const parent = room.parent_id ? byId.get(room.parent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export interface RoomDescendant {
  room: Room;
  depth: number;
}

export function roomDescendantsWithDepth(rooms: Room[], rootId: string): RoomDescendant[] {
  const children = new Map<string, Room[]>();
  for (const room of rooms) {
    if (!room.parent_id) continue;
    const siblings = children.get(room.parent_id) ?? [];
    siblings.push(room);
    children.set(room.parent_id, siblings);
  }
  const result: RoomDescendant[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const room of children.get(parentId) ?? []) {
      result.push({ room, depth });
      walk(room.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return result;
}

export interface FlatRoomOption {
  room: Room;
  depth: number;
}

export function flattenRoomTree(rooms: Room[]): FlatRoomOption[] {
  const result: FlatRoomOption[] = [];
  const walk = (nodes: RoomNode[], depth: number) => {
    for (const node of nodes) {
      result.push({ room: node, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildRoomTree(rooms), 0);
  return result;
}

export function collectDescendantIds(
  items: Array<{ id: string; parent_id: string | null }>,
  itemId: string,
): Set<string> {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parent_id === itemId || (item.parent_id && descendants.has(item.parent_id))) {
        if (!descendants.has(item.id)) {
          descendants.add(item.id);
          changed = true;
        }
      }
    }
  }
  return descendants;
}

export function flattenLocations<T extends { id: string; parent_id: string | null }>(
  locations: T[],
): Array<{ location: T; depth: number }> {
  const children = new Map<string | null, T[]>();
  for (const location of locations) {
    const key = location.parent_id;
    const list = children.get(key) ?? [];
    list.push(location);
    children.set(key, list);
  }
  const result: Array<{ location: T; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const location of children.get(parentId) ?? []) {
      result.push({ location, depth });
      walk(location.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

export function locationPath<T extends { id: string; parent_id: string | null }>(
  locations: T[],
  locationId: string,
): T[] {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const path: T[] = [];
  let cursor = byId.get(locationId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    path.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path;
}

export function roomPath(rooms: Room[], roomId: string): Room[] {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const path: Room[] = [];
  let cursor = byId.get(roomId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    path.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path;
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
