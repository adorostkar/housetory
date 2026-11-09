import type { MemberRole, UUID } from "@/lib/types/core";

export interface User {
  id: UUID;
  name: string;
  email: string;
  created_at: string;
}

export interface Household {
  id: UUID;
  name: string;
  default_currency: string;
  warranty_reminder_days: number;
  item_image_auto_reference?: boolean;
}

export interface HouseholdMembership extends Household {
  role: MemberRole;
  property_count: number;
  is_current: boolean;
}

export interface SessionState {
  authenticated: boolean;
  setup_required: boolean;
  user: User | null;
  household: Household | null;
  role: MemberRole | null;
  households?: HouseholdMembership[];
}

export interface SearchHousehold {
  id: UUID;
  name: string;
  role: MemberRole;
}

export interface SearchProperty {
  id: UUID;
  name: string;
  is_archived: boolean;
}

export interface SearchScopeHousehold extends SearchHousehold {
  properties: SearchProperty[];
}

export interface SearchScopeList {
  items: SearchScopeHousehold[];
}

export interface HouseholdMember {
  user_id: UUID;
  name: string;
  email: string;
  role: MemberRole;
  joined_at: string;
}

export interface MemberList {
  members: HouseholdMember[];
  email_configured: boolean;
}

export interface HouseholdInvitation {
  id: UUID;
  email: string;
  role: MemberRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  last_sent_at: string | null;
  created_at: string;
}

export interface InvitationList {
  items: HouseholdInvitation[];
  email_configured: boolean;
}

export interface InvitationPublic {
  household_name: string;
  email: string;
  role: MemberRole;
  expires_at: string;
  account_exists: boolean;
  authenticated_email_matches: boolean;
}
