import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, buildQuery } from "@/lib/api";
import type {
  AiRecognition,
  AiRecognitionList,
  AiSettings,
  AiStatus,
  CategoryList,
  ContainerDetail,
  ContainerList,
  DocumentList,
  DocumentRecord,
  DocumentRelations,
  FinancialOverview,
  ImportBatchDetail,
  ImportBatchList,
  ItemDetailResponse,
  ItemList,
  LabelTemplateList,
  Overview,
  PhotoList,
  PurchaseList,
  QuickSearchResponse,
  RoomList,
  SessionState,
  StorageLocationList,
  TagList,
  WarrantyList,
  WarrantyStatus,
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
  documents: ["documents"] as const,
  document: (documentId: string) => ["document", documentId] as const,
  purchases: ["purchases"] as const,
  purchase: (purchaseId: string) => ["purchase", purchaseId] as const,
  warranties: ["warranties"] as const,
  warrantyList: (status: string) => ["warranties", status] as const,
  financial: ["financial"] as const,
  imports: ["imports"] as const,
  importBatch: (batchId: string) => ["imports", batchId] as const,
  aiStatus: ["ai", "status"] as const,
  aiSettings: ["ai", "settings"] as const,
  recognitions: ["ai", "recognitions"] as const,
  recognition: (recognitionId: string) => ["ai", "recognition", recognitionId] as const,
  aiProviderModels: (providerId: string) => ["ai", "provider", providerId, "models"] as const,
  roomPhotos: (roomId: string) => ["photos", "room", roomId] as const,
  locationPhotos: (locationId: string) => ["photos", "location", locationId] as const,
  quickSearch: ["search", "quick"] as const,
  containers: ["containers"] as const,
  container: (containerId: string) => ["containers", containerId] as const,
  labelTemplates: ["labels", "templates"] as const,
  qrConfig: ["containers", "qr-config"] as const,
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
  include_descendants?: boolean;
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

export function useQuickSearch(q: string, limit = 4, enabled = true) {
  const term = q.trim();
  return useQuery({
    queryKey: [...queryKeys.quickSearch, term, limit],
    queryFn: ({ signal }) =>
      api.get<QuickSearchResponse>(
        `/search/quick${buildQuery({ q: term, limit })}`,
        { signal },
      ),
    enabled: enabled && term.length >= 2,
    staleTime: 10_000,
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

export interface DocumentFilters {
  q?: string;
  type?: string;
  item_id?: string;
  merchant?: string;
  date_from?: string;
  date_to?: string;
  ocr_status?: string;
  sort?: "created_desc" | "created_asc" | "document_date_desc" | "title_asc";
}

export function useDocuments(filters: DocumentFilters = {}, limit = 100) {
  return useQuery({
    queryKey: [...queryKeys.documents, filters, limit],
    queryFn: () =>
      api.get<DocumentList>(`/documents${buildQuery({ ...filters, limit })}`),
  });
}

export function useDocumentRelations(documentId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.document(documentId ?? ""), "relations"],
    queryFn: () => api.get<DocumentRelations>(`/documents/${documentId}/related-items`),
    enabled: Boolean(documentId),
    staleTime: 30_000,
  });
}

export function useDocument(documentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.document(documentId ?? ""),
    queryFn: () => api.get<DocumentRecord>(`/documents/${documentId}`),
    enabled: Boolean(documentId),
    refetchInterval: (query) => {
      const status = (query.state.data as DocumentRecord | undefined)?.ocr_status;
      return status === "queued" || status === "processing" ? 2000 : false;
    },
  });
}

export interface PurchaseFilters {
  q?: string;
  item_id?: string;
  currency?: string;
  date_from?: string;
  date_to?: string;
  sort?: "purchase_date_desc" | "purchase_date_asc" | "created_desc" | "price_desc";
}

export function usePurchases(filters: PurchaseFilters = {}, limit = 100) {
  return useQuery({
    queryKey: [...queryKeys.purchases, filters, limit],
    queryFn: () =>
      api.get<PurchaseList>(`/purchases${buildQuery({ ...filters, limit })}`),
  });
}

export function useWarranties(status: WarrantyStatus | "all" = "all") {
  return useQuery({
    queryKey: queryKeys.warrantyList(status),
    queryFn: () => api.get<WarrantyList>(`/warranties${buildQuery({ status })}`),
  });
}

export function useFinancialOverview() {
  return useQuery({
    queryKey: queryKeys.financial,
    queryFn: () => api.get<FinancialOverview>("/financial-overview"),
  });
}

export function useImports(limit = 50) {
  return useQuery({
    queryKey: [...queryKeys.imports, limit],
    queryFn: () => api.get<ImportBatchList>(`/imports${buildQuery({ limit })}`),
  });
}

export function useImportBatch(batchId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.importBatch(batchId ?? ""),
    queryFn: () => api.get<ImportBatchDetail>(`/imports/${batchId}`),
    enabled: Boolean(batchId),
    refetchInterval: (query) => {
      const status = (query.state.data as ImportBatchDetail | undefined)?.status;
      return status === "queued" || status === "processing" ? 2000 : false;
    },
  });
}

export function useAiStatus(task = "assistant") {
  return useQuery({
    queryKey: [...queryKeys.aiStatus, task],
    queryFn: () => api.get<AiStatus>(`/ai/status?task=${encodeURIComponent(task)}`),
    staleTime: 30_000,
    retry: false,
  });
}

export function useRecognitions(limit = 20) {
  return useQuery({
    queryKey: [...queryKeys.recognitions, limit],
    queryFn: () => api.get<AiRecognitionList>(`/ai/recognitions${buildQuery({ limit })}`),
  });
}

export function useRecognition(recognitionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.recognition(recognitionId ?? ""),
    queryFn: () => api.get<AiRecognition>(`/ai/recognitions/${recognitionId}`),
    enabled: Boolean(recognitionId),
    refetchInterval: (query) => {
      const status = (query.state.data as AiRecognition | undefined)?.status;
      return status === "queued" || status === "processing" ? 1500 : false;
    },
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.documents });
    void queryClient.invalidateQueries({ queryKey: ["document"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.purchases });
    void queryClient.invalidateQueries({ queryKey: ["purchase"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.warranties });
    void queryClient.invalidateQueries({ queryKey: queryKeys.financial });
    void queryClient.invalidateQueries({ queryKey: queryKeys.imports });
    void queryClient.invalidateQueries({ queryKey: ["ai", "recognitions"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
    void queryClient.invalidateQueries({ queryKey: ["containers"] });
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


export interface ContainerFilters {
  q?: string;
  room_id?: string;
  container_type?: string;
  empty?: boolean;
  include_fixed?: boolean;
}

export function useContainers(filters: ContainerFilters = {}, limit = 200) {
  return useQuery({
    queryKey: [...queryKeys.containers, filters, limit],
    queryFn: () =>
      api.get<ContainerList>(`/containers${buildQuery({ ...filters, limit })}`),
  });
}

export function useContainer(containerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.container(containerId ?? ""),
    queryFn: () => api.get<ContainerDetail>(`/containers/${containerId}`),
    enabled: Boolean(containerId),
  });
}

export function useLabelTemplates() {
  return useQuery({
    queryKey: queryKeys.labelTemplates,
    queryFn: () => api.get<LabelTemplateList>("/labels/templates"),
    staleTime: 5 * 60_000,
  });
}

export function useQrConfig() {
  return useQuery({
    queryKey: queryKeys.qrConfig,
    queryFn: () => api.get<{ base_url: string; warning: string | null; local_only: boolean }>("/containers/qr-config"),
    staleTime: 60_000,
  });
}


export function useAiSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: () => api.get<AiSettings>("/ai/settings"),
    enabled,
    staleTime: 15_000,
  });
}

export function useRoomPhotos(roomId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.roomPhotos(roomId ?? ""),
    queryFn: () => api.get<PhotoList>(`/rooms/${roomId}/photos`),
    enabled: Boolean(roomId),
  });
}

export function useLocationPhotos(locationId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.locationPhotos(locationId ?? ""),
    queryFn: () => api.get<PhotoList>(`/locations/${locationId}/photos`),
    enabled: Boolean(locationId),
  });
}
