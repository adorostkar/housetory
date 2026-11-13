import { api } from "@/lib/api";

export interface AssistantIntent {
  intent: "question" | "supported_action" | "unsupported_action" | "ambiguous" | "unavailable";
  form: "items" | "rooms" | "loans" | "documents" | "account" | null;
}

export function classifyAssistantIntent(
  query: string,
  householdId: string,
  propertyId: string,
  signal: AbortSignal,
) {
  return api.post<AssistantIntent>(
    "/assistant/actions/intent",
    {
      query,
      ...(householdId ? { household_id: householdId } : {}),
      ...(propertyId ? { scope_property_id: propertyId } : {}),
    },
    { signal },
  );
}
