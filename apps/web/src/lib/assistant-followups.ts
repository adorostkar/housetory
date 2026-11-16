import type { SearchQueryResponse } from "@/lib/types";

function candidates(response?: SearchQueryResponse): string[] {
  switch (response?.tool) {
    case "list_outstanding_loans":
      return ["What is overdue?"];
    case "list_borrowed_items":
    case "find_borrowed_owner":
      return ["What do I need to return?"];
    case "locate_item":
      return response.items.length > 0 || response.borrowed.length > 0
        ? ["Who owns it?", "Does it have a warranty?", "Where was it bought?"]
        : [];
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
  return candidates(response)
    .filter((value) => {
      const key = value.toLowerCase();
      if (key === asked || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}
