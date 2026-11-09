import type { AiStatus } from "@/lib/types/ai";
import type { UUID } from "@/lib/types/core";
import type { SearchHousehold, SearchProperty } from "@/lib/types/households";
import type { ItemSummary } from "@/lib/types/items";
import type { BorrowedRecord } from "@/lib/types/loans";

export interface AssistantReference {
  type:
    | "item"
    | "document"
    | "room"
    | "location"
    | "purchase"
    | "warranty"
    | "loan";
  id: UUID;
  title: string;
  subtitle: string | null;
  url: string;
  household_id?: UUID | null;
  household_name?: string | null;
}

export interface NaturalSearchFilters {
  q: string | null;
  household_id?: UUID | null;
  property_id?: UUID | null;
  room_id: UUID | null;
  room_name: string | null;
  exclude_room_id: UUID | null;
  location_id: UUID | null;
  location_name: string | null;
  category_id: UUID | null;
  category_name: string | null;
  tag: string | null;
  missing_purchase: boolean;
  missing_purchase_date: boolean;
  missing_purchase_price: boolean;
  purchase_info_status:
    | "missing"
    | "unknown"
    | "not_applicable"
    | "recorded"
    | "missing_date"
    | "missing_price"
    | null;
  missing_serial: boolean;
  warranty_status: "active" | "expiring" | "expired" | null;
  purchased_after: string | null;
  purchased_before: string | null;
  min_purchase_cents: number | null;
  max_purchase_cents: number | null;
  sort: "relevance" | "purchase_desc" | "purchase_asc" | "name_asc";
}

export interface SearchContextItemRef {
  id: UUID;
  name: string;
}

export interface SearchContextLoanRef {
  id: UUID;
  item_id: UUID | null;
  item_name: string | null;
  borrower_name: string | null;
}

export interface SearchContextMemoryEntry {
  household_id: UUID;
  property_id: UUID | null;
  user_intent: string;
  answer_meaning: string | null;
}

export interface SearchConversationContext {
  scope_key: string | null;
  last_query: string | null;
  resolved_items: SearchContextItemRef[];
  candidate_items: SearchContextItemRef[];
  loans: SearchContextLoanRef[];
  dialogue_memory?: SearchContextMemoryEntry[];
}

export interface SearchQueryResponse {
  query: string;
  answer_direction?: "ltr" | "rtl" | "auto";
  preserve_terms?: string[];
  mode: "direct" | "ai" | "fallback";
  ai_used: boolean;
  ai_attempted: boolean;
  direct_match: boolean;
  ambiguous: boolean;
  needs_clarification: boolean;
  answer: string | null;
  answer_kind: string | null;
  interpretation: string;
  filters: NaturalSearchFilters;
  items: ItemSummary[];
  quick_results: QuickSearchResult[];
  borrowed: BorrowedRecord[];
  borrowed_total: number;
  total: number;
  documents: Array<{
    id: string;
    title: string;
    type: string;
    merchant: string | null;
    document_date: string | null;
    items: string[];
    url: string;
    household_id?: string;
    household_name?: string;
  }>;
  locations: Array<{
    id: string;
    type: "room" | "storage_location";
    name: string;
    url: string;
    room?: string | null;
    item_count?: number;
    household_id?: string;
    household_name?: string;
  }>;
  references: AssistantReference[];
  notices: string[];
  facts: Record<string, unknown>;
  tool: string | null;
  ai_status: AiStatus;
  context: SearchConversationContext;
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
}

export type QuickSearchKind = "item" | "container" | "location" | "borrowed";

export interface QuickSearchLoan {
  on_loan_quantity: number;
  borrower_names: string[];
  next_due_on: string | null;
}

export interface QuickSearchResult {
  id: UUID;
  kind: QuickSearchKind;
  title: string;
  subtitle: string | null;
  context: string | null;
  url: string;
  household?: SearchHousehold | null;
  loan: QuickSearchLoan | null;
}

export interface QuickSearchResponse {
  query: string;
  effective_query: string | null;
  question_like: boolean;
  results: QuickSearchResult[];
  scope_label?: string;
  households?: SearchHousehold[];
  property?: SearchProperty | null;
  notices?: string[];
}

export type OnlineSearchSource = "household" | "environment" | "none";

export interface OnlineSearchChannel {
  enabled: boolean;
  configured: boolean;
  source: OnlineSearchSource;
  provider: string | null;
  provider_label: string | null;
  reason: string | null;
}

export interface OnlineSearchReferenceChannel extends OnlineSearchChannel {
  permitted_source_domains: string[];
  policy_configured: boolean;
}

export interface OnlineSearchSettings {
  provider: "brave";
  supported_providers: string[];
  manual_enabled: boolean;
  reference_enabled: boolean;
  has_api_key: boolean;
  environment_api_key_available: boolean;
  credential_source: OnlineSearchSource;
  api_key_version: number;
  credential_storage_ready: boolean;
  permitted_source_domains: string[];
  max_permitted_domains: number;
  manual: OnlineSearchChannel;
  reference: OnlineSearchReferenceChannel;
  environment_manual_available: boolean;
  environment_reference_available: boolean;
  updated_at: string | null;
  warning: string | null;
}

export interface OnlineSearchTestResult {
  ok: boolean;
  message: string;
  manual_ok: boolean | null;
  reference_ok: boolean | null;
  source: OnlineSearchSource;
  provider_label: string | null;
  tested_at: string;
}
