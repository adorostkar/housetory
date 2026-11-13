import * as React from "react";
import { toast } from "sonner";

import { useSearchScope, type SearchScopeSelection } from "@/hooks/use-search-scope";
import { api, getApiErrorMessage } from "@/lib/api";
import { AssistantDocumentsProvider } from "@/lib/assistant-documents";
import {
  AssistantPageContextProvider,
  type AssistantPageReference,
  useAssistantPageContext,
} from "@/lib/assistant-page-context";
import { useSession } from "@/lib/queries";
import type { SearchTurn } from "@/lib/search-session";
import type { SearchConversationContext, SearchQueryResponse } from "@/lib/types";

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
  response?: SearchQueryResponse;
  pageReferences?: AssistantPageReference[];
}

interface Conversation {
  messages: AssistantMessage[];
  draft: string;
  turns: SearchTurn[];
  context: SearchConversationContext | null;
  pending: boolean;
}

type Updater<T> = T | ((current: T) => T);

interface SessionSnapshot {
  scopeKey: string;
  turns: SearchTurn[];
  context: SearchConversationContext | null;
  record: (query: string, response: SearchQueryResponse) => void;
}

interface AssistantConversationContextValue {
  selection: SearchScopeSelection | null;
  setSelection: (selection: SearchScopeSelection) => void;
  conversations: Record<string, Conversation>;
  setDraft: (scope: string, value: Updater<string>) => void;
  reset: (scope: string) => void;
  ask: (scope: string, selection: SearchScopeSelection, value: string, regenerate: boolean, session: SessionSnapshot, references: AssistantPageReference[]) => void;
}

const EMPTY: Conversation = {
  messages: [],
  draft: "",
  turns: [],
  context: null,
  pending: false,
};

const AssistantConversationContext =
  React.createContext<AssistantConversationContextValue | null>(null);

function ConversationStore({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = React.useState<SearchScopeSelection | null>(null);
  const [conversations, setConversations] = React.useState<Record<string, Conversation>>({});
  const conversationsRef = React.useRef(conversations);
  const controllers = React.useRef(new Set<AbortController>());

  React.useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, []);

  const update = React.useCallback((scope: string, change: (current: Conversation) => Conversation) => {
    const next = {
      ...conversationsRef.current,
      [scope]: change(conversationsRef.current[scope] ?? EMPTY),
    };
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const setDraft = React.useCallback((scope: string, value: Updater<string>) => {
    update(scope, (current) => ({
      ...current,
      draft: typeof value === "function" ? value(current.draft) : value,
    }));
  }, [update]);

  const reset = React.useCallback((scope: string) => {
    update(scope, () => EMPTY);
  }, [update]);

  const ask = React.useCallback((
    scope: string,
    selection: SearchScopeSelection,
    value: string,
    regenerate: boolean,
    session: SessionSnapshot,
    references: AssistantPageReference[],
  ) => {
    const current = conversationsRef.current[scope] ?? EMPTY;
    if (current.pending) return;
    const previousMessages = regenerate ? current.messages.slice(0, -2) : current.messages;
    const previousTurns = regenerate ? current.turns.slice(0, -2) : current.turns;
    const previousAnswer = [...previousMessages].reverse().find((message) => message.response);
    const pageReferences = regenerate
      ? current.messages[current.messages.length - 2]?.pageReferences ?? []
      : references;
    const seededSession = current.messages.length === 0 && session.scopeKey === scope;
    const history = seededSession ? session.turns : previousTurns;
    const context = regenerate ? previousAnswer?.response?.context : (
      seededSession ? session.context : current.context
    );
    const controller = new AbortController();
    controllers.current.add(controller);
    update(scope, (entry) => ({ ...entry, pending: true }));
    void api.post<SearchQueryResponse>(
      "/search/query",
      {
        query: value,
        explicit_ask: true,
        history,
        ...(context ? { context } : {}),
        ...(pageReferences.length ? {
          page_context: pageReferences.map(({ kind, id }) => ({ kind, id })),
        } : {}),
        ...(selection.householdId ? { household_id: selection.householdId } : {}),
        ...(selection.propertyId ? { property_id: selection.propertyId } : {}),
        limit: 40,
      },
      { signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted) return;
      const answer = response.answer ?? "No matching inventory records were returned.";
      update(scope, (entry) => ({
        ...entry,
        messages: [
          ...previousMessages,
          { role: "user", text: value, pageReferences },
          { role: "assistant", text: answer, response },
        ],
        turns: [
          ...history,
          { role: "user" as const, content: value.slice(0, 1200) },
          { role: "assistant" as const, content: answer.slice(0, 1200) },
        ].slice(-8),
        context: response.context,
        draft: !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        pending: false,
      }));
      if (session.scopeKey === scope) session.record(value, response);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      update(scope, (entry) => ({ ...entry, pending: false }));
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const value = React.useMemo(
    () => ({ selection, setSelection, conversations, setDraft, reset, ask }),
    [selection, conversations, setDraft, reset, ask],
  );
  return (
    <AssistantConversationContext.Provider value={value}>
      <AssistantPageContextProvider>
        <AssistantDocumentsProvider>{children}</AssistantDocumentsProvider>
      </AssistantPageContextProvider>
    </AssistantConversationContext.Provider>
  );
}

export function AssistantConversationProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.isPending) return null;
  return <ConversationStore key={session.data?.user?.id ?? "anonymous"}>{children}</ConversationStore>;
}

export function useAssistantConversation(scope: string) {
  const store = React.useContext(AssistantConversationContext);
  const { references } = useAssistantPageContext();
  if (!store) throw new Error("AssistantConversationProvider is required");
  const conversation = store.conversations[scope] ?? EMPTY;
  return {
    ...conversation,
    question: conversation.draft,
    setQuestion: (value: Updater<string>) => store.setDraft(scope, value),
    reset: () => store.reset(scope),
    ask: (selection: SearchScopeSelection, value: string, regenerate: boolean, session: SessionSnapshot) =>
      store.ask(scope, selection, value, regenerate, session, references),
  };
}

export function useAssistantScope() {
  const store = React.useContext(AssistantConversationContext);
  if (!store) throw new Error("AssistantConversationProvider is required");
  const scope = useSearchScope(false, true, {
    remember: false,
    initialSelection: store.selection ?? undefined,
    onSelectionChange: store.setSelection,
  });
  React.useLayoutEffect(() => {
    if (!store.selection) store.setSelection(scope.selection);
  }, [store.selection, store.setSelection, scope.selection]);
  return scope;
}
