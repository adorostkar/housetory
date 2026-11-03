import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, buildQuery } from "@/lib/api";
import type {
  CategoryList,
  ItemDetailResponse,
  ItemList,
  Overview,
  RoomList,
  SessionState,
  StorageLocationList,
  TagList,
} from "@/lib/types";

export const queryKeys = {
  session: ["session"] as const,
  overview: ["overview"] as const,
  rooms: ["rooms"] as const,
  locations: (roomId?: string) => ["locations", roomId ?? "all"] as const,
  categories: ["categories"] as const,
  tags: ["tags"] as const,
  items: ["items"] as const,
  item: (itemId: string) => ["item", itemId] as const,
};

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.get<SessionState>("/auth/session", { skipUnauthorizedEvent: true }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => api.get<Overview>("/overview"),
  });
}

export function useRooms() {
  return useQuery({
    queryKey: queryKeys.rooms,
    queryFn: () => api.get<RoomList>("/rooms"),
  });
}

export function useLocations(roomId?: string) {
  return useQuery({
    queryKey: queryKeys.locations(roomId),
    queryFn: () =>
      api.get<StorageLocationList>(
        `/storage-locations${buildQuery({ room_id: roomId })}`,
      ),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: () => api.get<CategoryList>("/categories"),
  });
}

export function useTags() {
  return useQuery({
    queryKey: queryKeys.tags,
    queryFn: () => api.get<TagList>("/tags"),
  });
}

export interface ItemFilters {
  q?: string;
  room_id?: string;
  location_id?: string;
  category_id?: string;
  tag_id?: string;
  include_archived?: boolean;
  sort?: "created_desc" | "created_asc" | "name_asc" | "name_desc" | "updated_desc";
}

export function useItems(filters: ItemFilters, limit = 24, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.items, filters, limit],
    queryFn: ({ pageParam }) =>
      api.get<ItemList>(
        `/items${buildQuery({
          ...filters,
          limit,
          offset: pageParam,
        })}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.items.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    enabled,
  });
}

export function useSearchItems(q: string, limit = 30) {
  return useQuery({
    queryKey: [...queryKeys.items, "search", q, limit],
    queryFn: () => api.get<ItemList>(`/items${buildQuery({ q, limit })}`),
    enabled: q.trim().length > 0,
    staleTime: 15_000,
  });
}

export function useItem(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.item(itemId ?? ""),
    queryFn: () => api.get<ItemDetailResponse>(`/items/${itemId}`),
    enabled: Boolean(itemId),
  });
}

export function useInvalidateInventory() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
    void queryClient.invalidateQueries({ queryKey: ["locations"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.items });
    void queryClient.invalidateQueries({ queryKey: ["item"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags });
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}
