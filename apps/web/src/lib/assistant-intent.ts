import { api } from "@/lib/api";

export interface AssistantIntent {
  intent:
    | "question"
    | "supported_action"
    | "unsupported_action"
    | "ambiguous"
    | "create_item"
    | "unavailable";
  form: "items" | "rooms" | "loans" | "documents" | "account" | null;
}

export function looksLikeItemDescription(value: string) {
  const englishDescription =
    /^\s*(?:(?:i|we)\s+(?:have\s+)?(?:bought|purchased|got|added|found|picked up)\b|(?:(?:please|could you|can you|would you)\s+)*(?:add|create)\s+(?:(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?[\p{L}\d][\p{L}\d .'-]{1,})/iu.test(
      value,
    );
  const persianDescription =
    /^\s*(?:لطفاً\s+)?[\p{L}\d][\p{L}\d .'-]*\s+را\s+(?:به|در)\s+.+\s+اضافه\s+کن(?:ید)?[.!?؟]*\s*$/u.test(
      value,
    );
  return englishDescription || persianDescription;
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
