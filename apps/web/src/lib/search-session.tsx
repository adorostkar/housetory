import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { useSession } from "@/lib/queries";
import type {
  SearchConversationContext,
  SearchQueryResponse,
} from "@/lib/types";

export interface SearchTurn {
  role: "user" | "assistant";
  content: string;
}

interface StoredSearchSession {
  scopeKey: string;
  turns: SearchTurn[];
  context: SearchConversationContext | null;
  lastQuery: string | null;
}

interface SearchSessionValue extends StoredSearchSession {
  record: (query: string, response: SearchQueryResponse) => void;
  reset: () => void;
}

const STORAGE_PREFIX = "housetory-search-session";
const MAX_TURNS = 8;
const MAX_CONTENT = 1200;

const SearchSessionContext = React.createContext<SearchSessionValue | null>(null);

function readStoredScope() {
  try {
    const raw = window.localStorage.getItem("housetory-search-scope");
    if (!raw) return { householdId: "", propertyId: "" };
    const parsed = JSON.parse(raw) as {
      householdId?: string;
      propertyId?: string;
    };
    return {
      householdId: typeof parsed.householdId === "string" ? parsed.householdId : "",
      propertyId: typeof parsed.propertyId === "string" ? parsed.propertyId : "",
    };
  } catch {
    return { householdId: "", propertyId: "" };
  }
}

function readSession(key: string): StoredSearchSession | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSearchSession>;
    if (!parsed || typeof parsed.scopeKey !== "string") return null;
    return {
      scopeKey: parsed.scopeKey,
      turns: Array.isArray(parsed.turns)
        ? parsed.turns
            .filter(
              (turn): turn is SearchTurn =>
                turn?.role === "user" || turn?.role === "assistant",
            )
            .slice(-MAX_TURNS)
        : [],
      context: parsed.context ?? null,
      lastQuery: parsed.lastQuery ?? null,
    };
  } catch {
    return null;
  }
}

function writeSession(key: string, value: StoredSearchSession) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Bounded session memory is best effort.
  }
}

function assistantSummary(response: SearchQueryResponse) {
  if (response.answer) return response.answer;
  if (response.items.length > 0) {
    return `Direct results: ${response.items
      .slice(0, 6)
      .map((item) => item.name)
      .join(", ")}`;
  }
  if (response.quick_results.length > 0) {
    return `Direct results: ${response.quick_results
      .slice(0, 6)
      .map((result) => result.title)
      .join(", ")}`;
  }
  return "No direct inventory results.";
}

export function SearchSessionProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const [searchParams] = useSearchParams();
  const userId = session.data?.user?.id ?? "anon";
  const storedScope = React.useMemo(readStoredScope, []);
  const urlHousehold = searchParams.get("household_id") ?? "";
  const urlProperty = searchParams.get("property_id") ?? "";
  const effectiveHousehold = urlHousehold || storedScope.householdId;
  const effectiveProperty = urlProperty || storedScope.propertyId;
  const scopeKey = `${effectiveHousehold}|${effectiveProperty}`;
  const storageKey = `${STORAGE_PREFIX}:${userId}`;
  const [state, setState] = React.useState<StoredSearchSession>(() => {
    const saved = readSession(storageKey);
    return saved && saved.scopeKey === scopeKey
      ? saved
      : { scopeKey, turns: [], context: null, lastQuery: null };
  });

  React.useEffect(() => {
    setState((current) => {
      if (current.scopeKey === scopeKey) return current;
      // Changing household/property invalidates candidate and loan references.
      const next: StoredSearchSession = {
        scopeKey,
        turns: [],
        context: null,
        lastQuery: null,
      };
      writeSession(storageKey, next);
      return next;
    });
  }, [scopeKey, storageKey]);

  React.useEffect(() => {
    // Reloading as a different account must not reuse another user's session.
    const saved = readSession(storageKey);
    if (saved && saved.scopeKey === scopeKey) {
      setState(saved);
    }
  }, [storageKey, scopeKey]);

  const record = React.useCallback(
    (query: string, response: SearchQueryResponse) => {
      setState((current) => {
        const boundedQuery = query.slice(0, MAX_CONTENT);
        const lastUserTurn = [...current.turns]
          .reverse()
          .find((turn) => turn.role === "user");
        if (lastUserTurn?.content === boundedQuery) {
          // Reloading the same URL or repeating the same lookup must not append
          // duplicate dialogue turns or grow provider context.
          const next: StoredSearchSession = {
            ...current,
            context: response.context,
            lastQuery: query,
          };
          writeSession(storageKey, next);
          return next;
        }
        const turns = [
          ...current.turns,
          { role: "user" as const, content: boundedQuery },
          {
            role: "assistant" as const,
            content: assistantSummary(response).slice(0, MAX_CONTENT),
          },
        ].slice(-MAX_TURNS);
        const next: StoredSearchSession = {
          scopeKey,
          turns,
          context: response.context,
          lastQuery: query,
        };
        writeSession(storageKey, next);
        return next;
      });
    },
    [scopeKey, storageKey],
  );

  const reset = React.useCallback(() => {
    setState({ scopeKey, turns: [], context: null, lastQuery: null });
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      // Best effort.
    }
  }, [scopeKey, storageKey]);

  const value = React.useMemo<SearchSessionValue>(
    () => ({ ...state, record, reset }),
    [state, record, reset],
  );

  return (
    <SearchSessionContext.Provider value={value}>
      {children}
    </SearchSessionContext.Provider>
  );
}

const FALLBACK_SESSION: SearchSessionValue = {
  scopeKey: "",
  turns: [],
  context: null,
  lastQuery: null,
  record: () => undefined,
  reset: () => undefined,
};

export function useSearchSession(): SearchSessionValue {
  return React.useContext(SearchSessionContext) ?? FALLBACK_SESSION;
}
