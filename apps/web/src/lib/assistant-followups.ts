import type { SearchQueryResponse } from "@/lib/types";

const GENERIC = [
  "What is on loan?",
  "Which warranties are expiring soon?",
  "Which items have no purchase information?",
];

function candidates(response?: SearchQueryResponse): string[] {
  switch (response?.tool) {
    case "list_outstanding_loans":
      return ["What is overdue?", "What do I need to return?", "Who owns the ladder?"];
    case "list_borrowed_items":
    case "find_borrowed_owner":
      return ["What do I need to return?", "What is on loan?", "What is overdue?"];
    case "locate_item":
      return response.items.length > 0 || response.borrowed.length > 0
        ? ["Who owns it?", "Does it have a warranty?", "Where was it bought?"]
        : ["What do I have stored in the attic?"];
    case "get_warranty_status":
      return ["Which items have no purchase information?", "What is on loan?"];
    case "get_purchase_history":
      return ["Which warranties are expiring soon?", "What is on loan?"];
    case "find_missing_information":
      return ["Which warranties are expiring soon?", "What is on loan?"];
    case "search_documents":
      return ["Which warranties are expiring soon?", "Which items have no purchase information?"];
    default:
      return [];
  }
}

export function followUpSuggestions(
  response: SearchQueryResponse | undefined,
  lastQuestion: string,
): string[] {
  const asked = lastQuestion.trim().toLowerCase();
  const seen = new Set<string>();
  return [...candidates(response), ...GENERIC]
    .filter((value) => {
      const key = value.toLowerCase();
      if (key === asked || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}
