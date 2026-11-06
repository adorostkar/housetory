import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, buildQuery, setActiveHouseholdId } from "@/lib/api";
import { localDateISO } from "@/lib/utils";
import type {
  AiRecognition,
  AiRecognitionList,
  AiSettings,
  BorrowedDetail,
  BorrowedFilters,
  BorrowedList,
  InvitationList,
  InvitationPublic,
  MemberList,
  AiStatus,
  CategoryList,
  ContainerDetail,
  ContainerList,
  DocumentList,
  DocumentRecord,
  DocumentRelations,
  EvidenceExportList,
  EvidenceExportRecord,
  EvidenceOptions,
  EvidencePreview,
  EvidenceScope,
  FinancialOverview,
  ItemManuals,
  ManualCandidateList,
  ImportBatchDetail,
  ImportBatchList,
  ItemDetailResponse,
  ItemImageState,
  ItemList,
  LabelTemplateList,
  Overview,
  PhotoList,
  Property,
  PropertyList,
  PurchaseList,
  QuickSearchResponse,
  RoomList,
  SearchItemList,
  SearchScopeList,
  OnlineSearchSettings,
  PlaceTransferPreview,
  SessionState,
  SystemStatus,
  SystemStatusSummary,
  StocktakeScopeSummary,
  StocktakeReview,
  StocktakeSessionDetail,
  StocktakeSessionList,
  StorageLocationList,
  TagList,
  VoiceConfig,
  VoiceNote,
  ActivityHistory,
  ItemLoanSummary,
  Loan,
  LoanDetail,
  LoanFilterStatus,
  LoanList,
  WarrantyList,
  WarrantyStatus,
} from "@/lib/types";

export const queryKeys = {
  session: ["session"] as const,
  overview: ["overview"] as const,
  rooms: ["rooms"] as const,
  properties: ["properties"] as const,
  property: (propertyId: string) => ["properties", propertyId] as const,
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
  onlineSearchSettings: ["settings", "online-search"] as const,
  placeTransferPreview: (
    kind: "location" | "room",
    id: string,
    roomId: string,
    locationId: string,
  ) => ["place-transfer-preview", kind, id, roomId, locationId] as const,
  systemStatusSummary: ["system", "status-summary"] as const,
  systemStatus: ["system", "status"] as const,
  householdMembers: ["household", "members"] as const,
  householdInvitations: ["household", "invitations"] as const,
  invitation: (token: string) => ["invitation", token] as const,
  recognitions: ["ai", "recognitions"] as const,
  recognition: (recognitionId: string) => ["ai", "recognition", recognitionId] as const,
  aiProviderModels: (providerId: string) => ["ai", "provider", providerId, "models"] as const,
  roomPhotos: (roomId: string) => ["photos", "room", roomId] as const,
  locationPhotos: (locationId: string) => ["photos", "location", locationId] as const,
  quickSearch: ["search", "quick"] as const,
  searchScopes: ["search", "scopes"] as const,
  containers: ["containers"] as const,
  container: (containerId: string) => ["containers", containerId] as const,
  labelTemplates: ["labels", "templates"] as const,
  qrConfig: ["containers", "qr-config"] as const,
  voiceConfig: ["voice", "config"] as const,
  voiceNote: (noteId: string) => ["voice", "note", noteId] as const,
  loans: ["loans"] as const,
  loan: (loanId: string) => ["loans", loanId] as const,
  borrowed: ["borrowed"] as const,
  borrowedRecord: (recordId: string) => ["borrowed", recordId] as const,
  itemLoans: (itemId: string) => ["items", itemId, "loans"] as const,
  itemHistory: (itemId: string) => ["items", itemId, "history"] as const,
  itemManuals: (itemId: string) => ["items", itemId, "manuals"] as const,
  itemImage: (itemId: string) => ["items", itemId, "image"] as const,
  itemManualCandidates: (itemId: string) =>
    ["items", itemId, "manual-search"] as const,
  evidenceExports: ["evidence-exports"] as const,
  evidenceExport: (exportId: string) => ["evidence-exports", exportId] as const,
  stocktakeSessions: ["stocktake", "sessions"] as const,
  stocktakeSession: (sessionId: string) => ["stocktake", sessionId] as const,
  stocktakeSummary: (scopeKey: string) => ["stocktake", "summary", scopeKey] as const,
  containerHistory: (containerId: string) =>
    ["containers", containerId, "history"] as const,
};

export function applyHouseholdSession(
  queryClient: ReturnType<typeof useQueryClient>,
  state: SessionState,
) {
  const previous = queryClient.getQueryData<SessionState>(queryKeys.session)?.household?.id;
  setActiveHouseholdId(state.household?.id ?? null);
  void queryClient.cancelQueries();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, state);
  try {
    window.localStorage.removeItem("housetory-property-filter");
    const stored = window.localStorage.getItem("housetory-search-scope");
    if (stored) {
      const scope = JSON.parse(stored) as { householdId?: string; propertyId?: string };
      if (scope.householdId && scope.householdId === previous) {
        window.localStorage.removeItem("housetory-search-scope");
      }
    }
  } catch {
    // Local remembered filters are best effort.
  }
}

export interface SearchScopeValue {
  householdId: string;
  propertyId: string;
}

export interface LoanFilters {
  status?: LoanFilterStatus;
  item_id?: string;
  q?: string;
  overdue?: boolean;
  on_date?: string;
}

export function useLoans(filters: LoanFilters = {}, limit = 50) {
  return useQuery({
    queryKey: [...queryKeys.loans, filters, limit],
    queryFn: () =>
      api.get<LoanList>(
        `/loans${buildQuery({
          status: filters.status ?? "open",
          item_id: filters.item_id,
          q: filters.q,
          overdue: filters.overdue ? "true" : undefined,
          on_date: filters.on_date ?? localDateISO(),
          limit,
        })}`,
      ),
  });
}

export function useBorrowedList(filters: BorrowedFilters = {}, limit = 50, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.borrowed, filters, limit],
    queryFn: () =>
      api.get<BorrowedList>(
        `/borrowed${buildQuery({
          status: filters.status ?? "open",
          q: filters.q,
          overdue: filters.overdue ? "true" : undefined,
          property_id: filters.property_id,
          room_id: filters.room_id,
          storage_location_id: filters.storage_location_id,
          on_date: filters.on_date ?? localDateISO(),
          limit,
        })}`,
      ),
    enabled,
  });
}

export function useBorrowedRecord(recordId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.borrowedRecord(recordId ?? ""),
    queryFn: () =>
      api.get<BorrowedDetail>(
        `/borrowed/${recordId}${buildQuery({ on_date: localDateISO() })}`,
      ),
    enabled: Boolean(recordId),
  });
}

export function useLoan(loanId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.loan(loanId ?? ""),
    queryFn: () =>
      api.get<LoanDetail>(`/loans/${loanId}${buildQuery({ on_date: localDateISO() })}`),
    enabled: Boolean(loanId),
  });
}

export function useItemLoans(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.itemLoans(itemId ?? ""),
    queryFn: () =>
      api.get<ItemLoanSummary>(
        `/items/${itemId}/loans${buildQuery({ on_date: localDateISO() })}`,
      ),
    enabled: Boolean(itemId),
  });
}

export function useItemManuals(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.itemManuals(itemId ?? ""),
    queryFn: () => api.get<ItemManuals>(`/items/${itemId}/manuals`),
    enabled: Boolean(itemId),
  });
}

export function useEvidenceExports(enabled = true) {
  return useQuery({
    queryKey: queryKeys.evidenceExports,
    queryFn: () => api.get<EvidenceExportList>("/evidence-exports?limit=20"),
    enabled,
  });
}

export function useEvidenceExport(exportId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.evidenceExport(exportId ?? ""),
    queryFn: () => api.get<EvidenceExportRecord>(`/evidence-exports/${exportId}`),
    enabled: Boolean(exportId) && enabled,
    refetchInterval: (query) => {
      const status = (query.state.data as EvidenceExportRecord | undefined)?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

export function useEvidencePreview(
  scope: EvidenceScope | null,
  includeArchived: boolean,
  options: EvidenceOptions,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "evidence-exports",
      "preview",
      scope,
      includeArchived,
      options,
    ],
    queryFn: () =>
      api.post<EvidencePreview>("/evidence-exports/preview", {
        scope,
        include_archived: includeArchived,
        options,
      }),
    enabled: enabled && Boolean(scope),
    retry: false,
    staleTime: 0,
  });
}

export function useManualCandidates(itemId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.itemManualCandidates(itemId ?? ""),
    queryFn: () => api.get<ManualCandidateList>(`/items/${itemId}/manual-search`),
    enabled: Boolean(itemId) && enabled,
  });
}

export function useItemHistory(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.itemHistory(itemId ?? ""),
    queryFn: () => api.get<ActivityHistory>(`/items/${itemId}/history`),
    enabled: Boolean(itemId),
  });
}

export function useContainerHistory(containerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.containerHistory(containerId ?? ""),
    queryFn: () => api.get<ActivityHistory>(`/containers/${containerId}/history`),
    enabled: Boolean(containerId),
  });
}

export function useLoanReference(loanId: string | undefined): Loan | undefined {
  const detail = useLoan(loanId);
  return detail.data;
}

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.get<SessionState>("/auth/session", { skipUnauthorizedEvent: true }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateHousehold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; property_name?: string }) =>
      api.post<SessionState>("/households", payload),
    onSuccess: (state) => applyHouseholdSession(queryClient, state),
  });
}

export function useSelectHousehold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (householdId: string) =>
      api.post<SessionState>(`/households/${householdId}/select`),
    onSuccess: (state) => applyHouseholdSession(queryClient, state),
  });
}

export function useSearchScopes(enabled = true) {
  return useQuery({
    queryKey: queryKeys.searchScopes,
    queryFn: () => api.get<SearchScopeList>("/search/scopes"),
    staleTime: 30_000,
    enabled,
  });
}

export function useAllPlacesItems(
  filters: { q?: string; household_id?: string; property_id?: string; sort?: string },
  limit = 30,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.items, "all-places", filters, limit],
    queryFn: ({ pageParam }) =>
      api.get<SearchItemList>(
        `/search/items${buildQuery({
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

export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => api.get<Overview>("/overview"),
  });
}

export function useProperties(includeArchived = false) {
  return useQuery({
    queryKey: [...queryKeys.properties, includeArchived],
    queryFn: () =>
      api.get<PropertyList>(`/properties${buildQuery({ include_archived: includeArchived })}`),
  });
}

export function useProperty(propertyId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.property(propertyId ?? ""),
    queryFn: () => api.get<Property>(`/properties/${propertyId}`),
    enabled: Boolean(propertyId),
  });
}

export function useRooms(propertyId?: string) {
  return useQuery({
    queryKey: [...queryKeys.rooms, propertyId ?? "all"],
    queryFn: () => api.get<RoomList>(`/rooms${buildQuery({ property_id: propertyId })}`),
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
  property_id?: string;
  room_id?: string;
  location_id?: string;
  category_id?: string;
  tag_id?: string;
  purchase_info?: string;
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

export function useQuickSearch(
  q: string,
  limit = 4,
  enabled = true,
  scope?: SearchScopeValue,
) {
  const term = q.trim();
  return useQuery({
    queryKey: [
      ...queryKeys.quickSearch,
      term,
      limit,
      scope?.householdId ?? "",
      scope?.propertyId ?? "",
    ],
    queryFn: ({ signal }) =>
      api.get<QuickSearchResponse>(
        `/search/quick${buildQuery({
          q: term,
          limit,
          household_id: scope?.householdId,
          property_id: scope?.propertyId,
        })}`,
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

export function useItemImage(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.itemImage(itemId ?? ""),
    queryFn: () => api.get<ItemImageState>(`/items/${itemId}/image`),
    enabled: Boolean(itemId),
    staleTime: 10_000,
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

export function useDocuments(filters: DocumentFilters = {}, limit = 100, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.documents, filters, limit],
    queryFn: () =>
      api.get<DocumentList>(`/documents${buildQuery({ ...filters, limit })}`),
    enabled,
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

export function useVoiceConfig() {
  return useQuery({
    queryKey: queryKeys.voiceConfig,
    queryFn: () => api.get<VoiceConfig>("/voice/config"),
    staleTime: 60_000,
    retry: false,
  });
}

export function useVoiceNote(noteId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.voiceNote(noteId ?? ""),
    queryFn: () => api.get<VoiceNote>(`/voice/${noteId}`),
    enabled: Boolean(noteId),
    refetchInterval: (query) => {
      const status = (query.state.data as VoiceNote | undefined)?.status;
      return status === "queued" ||
        status === "transcribing" ||
        status === "interpreting" ||
        status === "applying"
        ? 1500
        : false;
    },
  });
}

export function useAiStatus(
  task = "assistant",
  options: { refetchOnMount?: boolean | "always" } = {},
) {
  return useQuery({
    queryKey: [...queryKeys.aiStatus, task],
    queryFn: () => api.get<AiStatus>(`/ai/status?task=${encodeURIComponent(task)}`),
    staleTime: 30_000,
    refetchOnMount: options.refetchOnMount ?? true,
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.properties });
    void queryClient.invalidateQueries({ queryKey: ["locations"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.items });
    void queryClient.invalidateQueries({ queryKey: ["item"] });
    void queryClient.invalidateQueries({ queryKey: ["items"] });
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
    void queryClient.invalidateQueries({ queryKey: ["stocktake"] });
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
  property_id?: string;
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

export function useStocktakeSessions(
  filters: { roomId?: string; containerId?: string; status?: string } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: [...queryKeys.stocktakeSessions, filters],
    queryFn: () =>
      api.get<StocktakeSessionList>(
        `/stocktake/sessions${buildQuery({
          room_id: filters.roomId,
          container_id: filters.containerId,
          status: filters.status,
          limit: 20,
        })}`,
      ),
    enabled,
  });
}

export function useStocktakeSession(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.stocktakeSession(sessionId ?? ""),
    queryFn: () => api.get<StocktakeSessionDetail>(`/stocktake/sessions/${sessionId}`),
    enabled: Boolean(sessionId) && enabled,
    staleTime: 0,
  });
}

export function useStocktakeScopeSummary(
  scope: { roomId?: string; containerId?: string },
  enabled = true,
) {
  const scopeKey = scope.roomId ? `room:${scope.roomId}` : `container:${scope.containerId}`;
  return useQuery({
    queryKey: queryKeys.stocktakeSummary(scopeKey),
    queryFn: () =>
      api.get<StocktakeScopeSummary>(
        `/stocktake/summary${buildQuery({
          room_id: scope.roomId,
          container_id: scope.containerId,
        })}`,
      ),
    enabled: enabled && Boolean(scope.roomId || scope.containerId),
    staleTime: 0,
  });
}

export function useStocktakeReview(sessionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.stocktakeSession(sessionId ?? ""), "review"],
    queryFn: () => api.get<StocktakeReview>(`/stocktake/sessions/${sessionId}/review`),
    enabled: Boolean(sessionId) && enabled,
    staleTime: 0,
  });
}

export function useContainer(containerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.container(containerId ?? ""),
    queryFn: () => api.get<ContainerDetail>(`/containers/${containerId}`),
    enabled: Boolean(containerId),
  });
}

export function usePlaceTransferPreview(
  kind: "location" | "room",
  id: string | undefined,
  destinationRoomId: string,
  destinationLocationId: string,
  enabled = true,
) {
  const params = new URLSearchParams();
  if (destinationRoomId) params.set("destination_room_id", destinationRoomId);
  if (destinationLocationId) params.set("destination_location_id", destinationLocationId);
  const query = params.toString();
  return useQuery({
    queryKey: queryKeys.placeTransferPreview(
      kind,
      id ?? "",
      destinationRoomId,
      destinationLocationId,
    ),
    queryFn: () =>
      api.get<PlaceTransferPreview>(
        `/place-management/${kind === "room" ? "rooms" : "locations"}/${id}/preview${
          query ? `?${query}` : ""
        }`,
      ),
    enabled: Boolean(id) && enabled,
    staleTime: 0,
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

export function useOnlineSearchSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.onlineSearchSettings,
    queryFn: () => api.get<OnlineSearchSettings>("/settings/online-search"),
    enabled,
    staleTime: 10_000,
  });
}

export function useSystemStatusSummary(enabled = true) {
  return useQuery({
    queryKey: queryKeys.systemStatusSummary,
    queryFn: () => api.get<SystemStatusSummary>("/system/status/summary"),
    enabled,
    staleTime: 10_000,
  });
}

export function useSystemStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.systemStatus,
    queryFn: () => api.get<SystemStatus>("/system/status"),
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


export function useCanWrite() {
  const session = useSession();
  return session.data?.role === "owner" || session.data?.role === "member";
}

export function useIsOwner() {
  const session = useSession();
  return session.data?.role === "owner";
}


export function useHouseholdMembers() {
  return useQuery({
    queryKey: queryKeys.householdMembers,
    queryFn: () => api.get<MemberList>("/household/members"),
  });
}

export function useHouseholdInvitations() {
  return useQuery({
    queryKey: queryKeys.householdInvitations,
    queryFn: () => api.get<InvitationList>("/household/invitations"),
  });
}

export function useInvitation(token: string | undefined) {
  return useQuery({
    queryKey: queryKeys.invitation(token ?? ""),
    queryFn: () => api.get<InvitationPublic>(`/invitations/${encodeURIComponent(token ?? "")}`),
    enabled: Boolean(token),
    retry: false,
  });
}
