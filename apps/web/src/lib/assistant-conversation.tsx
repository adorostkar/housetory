import * as React from "react";
import { toast } from "sonner";

import { useSearchScope, type SearchScopeSelection } from "@/hooks/use-search-scope";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { AssistantDocumentsProvider } from "@/lib/assistant-documents";
import {
  AssistantPageContextProvider,
  type AssistantPageReference,
  useAssistantPageContext,
} from "@/lib/assistant-page-context";
import { useInvalidateInventory, useSession } from "@/lib/queries";
import type { SearchTurn } from "@/lib/search-session";
import type { SearchConversationContext, SearchQueryResponse } from "@/lib/types";
import { localDateISO } from "@/lib/utils";
import { withHousehold } from "@/lib/household-links";
import { classifyAssistantIntent } from "@/lib/assistant-intent";

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
  response?: SearchQueryResponse;
  pageReferences?: AssistantPageReference[];
  fallback?: { href: string; label: string };
  action?: AssistantActionState;
  clarification?: ActionClarification;
}

interface ActionClarification {
  id: string;
  query: string;
  selection: SearchScopeSelection;
  pageReferences: AssistantPageReference[];
  conversationItemIds: string[];
  localDate: string;
  choices: { id: string; name: string }[];
  resolved: boolean;
}

type ClarificationReply =
  | { itemId: string; text: string }
  | { location: string; text: string };

export interface AssistantActionProposal {
  id: string;
  kind: string;
  state: string;
  scope_label: string;
  targets: { id: string; name: string }[];
  destination: { id: string; name: string } | null;
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
}

interface AssistantActionState {
  proposal: AssistantActionProposal;
  requestId: string;
  pending: boolean;
  clarificationLabel?: string;
  result?: string;
  conflict?: string;
  editing?: boolean;
  destinations?: AssistantMoveDestination[];
  selectedDestination?: string;
  itemDraft?: ItemDraft;
  loanDraft?: LoanDraft;
  returnDraft?: ReturnDraft;
}

export const ITEM_EDIT_FIELDS = [
  { key: "name", label: "New name", maxLength: 200 },
  { key: "description", label: "Description", maxLength: 4000 },
  { key: "brand", label: "Brand", maxLength: 120 },
  { key: "model", label: "Model", maxLength: 120 },
  { key: "serial_number", label: "Serial number", maxLength: 200 },
  { key: "quantity", label: "Quantity" },
  { key: "condition", label: "Condition" },
] as const;
type ItemField = typeof ITEM_EDIT_FIELDS[number]["key"];
type ItemDraft = Record<ItemField, string>;

interface ReturnDraft {
  quantity: string;
  returned_on: string;
}

interface LoanDraft {
  borrower_name: string;
  quantity: string;
  lent_on: string;
  due_on: string;
  item_name?: string;
}

interface AssistantMoveDestination {
  room_id: string;
  storage_location_id: string | null;
  name: string;
}

interface AssistantActionInterpretResult {
  handled: boolean;
  message: string;
  proposal: AssistantActionProposal | null;
  item_choices?: { id: string; name: string }[];
}

interface Conversation {
  messages: AssistantMessage[];
  draft: string;
  turns: SearchTurn[];
  context: SearchConversationContext | null;
  actionItemIds: string[] | null;
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
  clarifyAction: (scope: string, clarificationId: string, reply: ClarificationReply) => void;
  applyAction: (scope: string, proposalId: string) => void;
  cancelAction: (scope: string, proposalId: string) => void;
  refreshAction: (scope: string, proposalId: string) => void;
  editMove: (scope: string, proposalId: string) => void;
  selectDestination: (scope: string, proposalId: string, destination: string) => void;
  saveMove: (scope: string, proposalId: string) => void;
  editName: (scope: string, proposalId: string) => void;
  setItemField: (scope: string, proposalId: string, field: ItemField, value: string) => void;
  saveName: (scope: string, proposalId: string) => void;
  editLoan: (scope: string, proposalId: string) => void;
  setLoanDraft: (scope: string, proposalId: string, changes: Partial<LoanDraft>) => void;
  saveLoan: (scope: string, proposalId: string) => void;
  editReturn: (scope: string, proposalId: string) => void;
  setReturnDraft: (scope: string, proposalId: string, changes: Partial<ReturnDraft>) => void;
  saveReturn: (scope: string, proposalId: string) => void;
}

const EMPTY: Conversation = {
  messages: [],
  draft: "",
  turns: [],
  context: null,
  actionItemIds: null,
  pending: false,
};

function proposalItemIds(proposal: AssistantActionProposal): string[] {
  if (!["edit_item", "move_items", "lend"].includes(proposal.kind) || proposal.targets.length > 6) {
    return [];
  }
  return proposal.targets.map(({ id }) => id);
}

const AssistantConversationContext =
  React.createContext<AssistantConversationContextValue | null>(null);

function ConversationStore({ children }: { children: React.ReactNode }) {
  const invalidateInventory = useInvalidateInventory();
  const invalidateLoans = useInvalidateInventory(["loans"]);
  const invalidateBorrowed = useInvalidateInventory(["borrowed"]);
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
    update(scope, (current) =>
      current.pending || current.messages.some((message) => message.action?.pending) ? current : EMPTY,
    );
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
    const actionText = value.replace(/^\s*(?:(?:please|can you|could you|would you|i want to|i need to)\s+)*/i, "");
    const unsupportedAccount = /^(?:change|set|reset|update)\s+(?:my\s+)?(?:password|email|account)\b/i.test(actionText);
    const unsupportedDelete = /^(?:delete|erase)\b/i.test(actionText)
      || /\s(?:حذف|پاک)\s+کن\s*[.!?؟]?\s*$/u.test(value);
    const unsupportedMerge = /^merge\b/i.test(actionText);
    const unsupportedArchive = /^(?:archive|unarchive|restore)\b/i.test(actionText);
    const unsupportedDisposition = /^(?:sell|donate|discard|dispose of)\b/i.test(actionText);
    const unsupportedRoomCreation = /^(?:create|add|make)\s+(?:(?:a|an|the|new)\s+)*room\b/i.test(actionText);
    const isUnsupported = unsupportedAccount || unsupportedDelete || unsupportedMerge
      || unsupportedArchive || unsupportedDisposition || unsupportedRoomCreation;
    const respondUnsupported = () => {
      const answer = unsupportedAccount
        ? "The assistant cannot change account settings. Use the existing account settings."
        : unsupportedRoomCreation
        ? "The assistant cannot create rooms. Use the existing room controls."
        : unsupportedDelete
        ? "The assistant cannot delete items. Use the existing item controls."
        : unsupportedMerge
          ? "The assistant cannot merge inventory items. Use the existing item controls."
          : unsupportedArchive
            ? "The assistant cannot archive or restore items. Use the existing item controls."
            : "The assistant cannot record item disposition. Use the existing item controls.";
      const fallback = unsupportedAccount
        ? { href: "/settings/account", label: "Open account settings" }
        : unsupportedRoomCreation
        ? { href: withHousehold("/rooms", selection.householdId || undefined), label: "Open rooms" }
        : { href: withHousehold("/items", selection.householdId || undefined), label: "Open items" };
      update(scope, (entry) => ({
        ...entry,
        messages: [
          ...(regenerate ? entry.messages.slice(0, -2) : entry.messages),
          { role: "user", text: value, pageReferences },
          { role: "assistant", text: answer, fallback },
        ],
        turns: [...history, { role: "user" as const, content: value }, { role: "assistant" as const, content: answer }].slice(-8),
        draft: !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        pending: false,
      }));
    };
    const controller = new AbortController();
    controllers.current.add(controller);
    update(scope, (entry) => ({ ...entry, pending: true }));
    const body = {
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
    };
    const isAction = /^(?:move|relocate|put|rename|lend|borrow|return)\s/i.test(actionText)
      || /^(?:set|change)\s.+\b(?:name|description|brand|model|serial number|quantity|condition)\s+to\s/i.test(actionText)
      || /^record\s+(?:the\s+)?return\b/i.test(actionText)
      || /\sبه\s.+\s(?:منتقل\s+کن|ببر|ببرش)\s*[.!?؟]?\s*$/u.test(value)
      || /\sبه\s.+\sقرض\s+بده\s*[.!?؟]?\s*$/u.test(value)
      || /\sاز\s.+\sقرض\s+بگیر\s*[.!?؟]?\s*$/u.test(value)
      || /\s(?:از|به)\s.+\sپس\s+(?:بگیر|بده)\s*[.!?؟]?\s*$/u.test(value)
      || /^\s*نام\s.+\sبه\s.+\sتغییر\s+بده\s*[.!?؟]?\s*$/u.test(value);
    const runAction = () => {
      const localDate = localDateISO();
      const conversationItemIds = !regenerate && current.actionItemIds !== null
        ? current.actionItemIds
        : context?.resolved_items.map(({ id }) => id) ?? [];
      return api.post<AssistantActionInterpretResult>(
        "/assistant/actions/interpret",
        {
          query: value,
          local_date: localDate,
          ...(selection.householdId ? { household_id: selection.householdId } : {}),
          ...(selection.propertyId ? { scope_property_id: selection.propertyId } : {}),
          page_context: pageReferences.map(({ kind, id }) => ({ kind, id })),
          conversation_item_ids: conversationItemIds,
        },
        { signal: controller.signal },
      ).then((response) => {
        if (controller.signal.aborted) return;
        const answer = response.handled ? response.message : "I can't prepare that action yet. Use the existing inventory controls.";
        update(scope, (entry) => ({
          ...entry,
          messages: [
            ...(regenerate ? entry.messages.slice(0, -2) : entry.messages),
            { role: "user", text: value, pageReferences },
            {
              role: "assistant", text: answer,
              ...(response.proposal ? {
                action: { proposal: response.proposal, requestId: crypto.randomUUID(), pending: false },
              } : response.item_choices?.length ? {
                clarification: {
                  id: crypto.randomUUID(), query: value, selection, pageReferences,
                  conversationItemIds, localDate, choices: response.item_choices, resolved: false,
                },
              } : {
                fallback: /\b(?:lend|borrow|return|loan)\b|قرض|پس\s+(?:بگیر|بده)/u.test(value.toLowerCase())
                  ? { href: withHousehold("/loans", selection.householdId || undefined), label: "Open loans" }
                  : { href: withHousehold("/items", selection.householdId || undefined), label: "Open items" },
              }),
            },
          ],
          turns: [
            ...history,
            { role: "user" as const, content: value.slice(0, 1200) },
            { role: "assistant" as const, content: answer.slice(0, 1200) },
          ].slice(-8),
          actionItemIds: response.proposal ? proposalItemIds(response.proposal) : entry.actionItemIds,
          draft: !regenerate && entry.draft.trim() === value ? "" : entry.draft,
          pending: false,
        }));
      });
    };
    const runSearch = () => api.post<SearchQueryResponse>(
      "/search/query",
      body,
      { signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted) return;
      const answer = response.answer ?? "No matching inventory records were returned.";
      update(scope, (entry) => ({
        ...entry,
        messages: [
          ...(regenerate ? entry.messages.slice(0, -2) : entry.messages),
          { role: "user", text: value, pageReferences },
          { role: "assistant", text: answer, response },
        ],
        turns: [
          ...history,
          { role: "user" as const, content: value.slice(0, 1200) },
          { role: "assistant" as const, content: answer.slice(0, 1200) },
        ].slice(-8),
        context: response.context,
        actionItemIds: null,
        draft: !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        pending: false,
      }));
      if (session.scopeKey === scope) session.record(value, response);
    });
    const execute = classifyAssistantIntent(
      value, selection.householdId, selection.propertyId, controller.signal,
    ).catch((error: unknown) => {
      if (!controller.signal.aborted && error instanceof ApiError
        && (error.code === "intent_unavailable" || error.code === "intent_invalid")) {
        toast.error("AI intent interpretation is unavailable; using local routing.");
        return { intent: "unavailable" as const, form: null };
      }
      throw error;
    }).then((intent) => {
      if (controller.signal.aborted) return;
      if (intent.intent === "unavailable") {
        if (isUnsupported) {
          respondUnsupported();
          return;
        }
        return isAction ? runAction() : runSearch();
      }
      if (intent.intent === "question") return runSearch();
      if (intent.intent === "supported_action") return runAction();
      const answer = intent.intent === "ambiguous"
        ? "What would you like to change?"
        : "The assistant cannot perform that action. Use the existing controls.";
      const forms = {
        items: { href: "/items", label: "Open items" },
        rooms: { href: "/rooms", label: "Open rooms" },
        loans: { href: "/loans", label: "Open loans" },
        documents: { href: "/documents", label: "Open documents" },
        account: { href: "/settings/account", label: "Open account settings" },
      };
      const form = forms[intent.form ?? "items"];
      update(scope, (entry) => ({
        ...entry,
        messages: [
          ...(regenerate ? entry.messages.slice(0, -2) : entry.messages),
          { role: "user", text: value, pageReferences },
          {
            role: "assistant", text: answer,
            ...(intent.intent === "unsupported_action"
              ? { fallback: { ...form, href: withHousehold(form.href, selection.householdId || undefined) } }
              : {}),
          },
        ],
        turns: [
          ...history,
          { role: "user" as const, content: value.slice(0, 1200) },
          { role: "assistant" as const, content: answer },
        ].slice(-8),
        draft: !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        pending: false,
      }));
    });
    void execute.catch((error: unknown) => {
      if (controller.signal.aborted) return;
      update(scope, (entry) => ({ ...entry, pending: false }));
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const clarifyAction = React.useCallback((scope: string, clarificationId: string, reply: ClarificationReply) => {
    const current = conversationsRef.current[scope] ?? EMPTY;
    const clarification = current.messages.find(
      (message) => message.clarification?.id === clarificationId,
    )?.clarification;
    if (!clarification || clarification.resolved || current.pending) return;
    if ("itemId" in reply && !clarification.choices.some((candidate) => candidate.id === reply.itemId)) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    update(scope, (entry) => ({ ...entry, pending: true }));
    void api.post<AssistantActionInterpretResult>(
      "/assistant/actions/interpret",
      {
        query: clarification.query,
        local_date: clarification.localDate,
        ...(clarification.selection.householdId ? { household_id: clarification.selection.householdId } : {}),
        ...(clarification.selection.propertyId ? { scope_property_id: clarification.selection.propertyId } : {}),
        page_context: clarification.pageReferences.map(({ kind, id }) => ({ kind, id })),
        conversation_item_ids: clarification.conversationItemIds,
        ...("itemId" in reply ? { clarified_item_id: reply.itemId } : { clarified_item_location: reply.location }),
      },
      { signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted) return;
      const answer = response.handled ? response.message : "I can't prepare that action yet. Use the existing inventory controls.";
      const proposal = response.proposal;
      const target = proposal?.targets[0];
      const choice = clarification.choices.find((candidate) => candidate.id === target?.id);
      if (!proposal || !choice || ("itemId" in reply && reply.itemId !== choice.id)) {
        update(scope, (entry) => ({ ...entry, pending: false }));
        toast.error(proposal ? "The selected item changed. Please choose again." : answer);
        return;
      }
      update(scope, (entry) => ({
        ...entry,
        messages: [
          ...entry.messages.map((message) =>
            message.clarification?.id === clarificationId
              ? { ...message, clarification: { ...message.clarification, resolved: true } }
              : message,
          ),
          { role: "user", text: reply.text },
          {
            role: "assistant", text: answer,
            action: { proposal, requestId: crypto.randomUUID(), pending: false, clarificationLabel: choice.name },
          },
        ],
        turns: [
          ...entry.turns,
          { role: "user" as const, content: reply.text.slice(0, 1200) },
          { role: "assistant" as const, content: answer.slice(0, 1200) },
        ].slice(-8),
        actionItemIds: proposalItemIds(proposal),
        draft: entry.draft.trim() === reply.text ? "" : entry.draft,
        pending: false,
      }));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      update(scope, (entry) => ({ ...entry, pending: false }));
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const applyAction = React.useCallback((scope: string, proposalId: string) => {
    const current = conversationsRef.current[scope] ?? EMPTY;
    const action = current.messages.find((message) => message.action?.proposal.id === proposalId)?.action;
    if (!action || action.pending || action.result || action.conflict) return;
    const changeAction = (change: (entry: AssistantActionState) => AssistantActionState) => {
      update(scope, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.action?.proposal.id === proposalId
            ? { ...message, action: change(message.action) }
            : message,
        ),
      }));
    };
    changeAction((entry) => ({ ...entry, pending: true }));
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.post<{ message: string }>(
      `/assistant/actions/proposals/${proposalId}/apply`,
      { request_id: action.requestId },
      { signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted) return;
      changeAction((entry) => ({ ...entry, pending: false, result: response.message }));
      invalidateInventory();
      invalidateLoans();
      invalidateBorrowed();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "proposal_stale") {
        changeAction((entry) => ({ ...entry, pending: false, conflict: error.message }));
      } else {
        changeAction((entry) => ({ ...entry, pending: false }));
        toast.error(getApiErrorMessage(error));
      }
    }).finally(() => controllers.current.delete(controller));
  }, [invalidateInventory, invalidateLoans, invalidateBorrowed, update]);

  const refreshAction = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result || !action.conflict) return;
    const change = (patch: Partial<AssistantActionState>) => update(scope, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.action?.proposal.id === proposalId
          ? { ...message, action: { ...message.action, ...patch } }
          : message,
      ),
    }));
    change({ pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.post<AssistantActionProposal>(
      `/assistant/actions/proposals/${proposalId}/refresh`,
      undefined,
      { signal: controller.signal },
    ).then((proposal) => {
      if (controller.signal.aborted) return;
      change({ proposal, pending: false, conflict: undefined, editing: false, requestId: crypto.randomUUID() });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      change({ pending: false });
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const cancelAction = React.useCallback((scope: string, proposalId: string) => {
    const current = conversationsRef.current[scope] ?? EMPTY;
    const action = current.messages.find((message) => message.action?.proposal.id === proposalId)?.action;
    if (!action || action.pending || action.result) return;
    const changeAction = (change: (entry: AssistantActionState) => AssistantActionState) => {
      update(scope, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.action?.proposal.id === proposalId
            ? { ...message, action: change(message.action) }
            : message,
        ),
      }));
    };
    changeAction((entry) => ({ ...entry, pending: true }));
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.post(`/assistant/actions/proposals/${proposalId}/cancel`, undefined, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        changeAction((entry) => ({ ...entry, pending: false, result: "Proposal cancelled. Nothing was changed." }));
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        changeAction((entry) => ({ ...entry, pending: false }));
        toast.error(getApiErrorMessage(error));
      }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const editMove = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result) return;
    const change = (patch: Partial<AssistantActionState>) => update(scope, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.action?.proposal.id === proposalId
          ? { ...message, action: { ...message.action, ...patch } }
          : message,
      ),
    }));
    change({ pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.get<{ items: AssistantMoveDestination[] }>(
      `/assistant/actions/proposals/${proposalId}/destinations`,
      { signal: controller.signal },
    ).then((response) => {
      if (controller.signal.aborted) return;
      change({ pending: false, editing: true, destinations: response.items, selectedDestination: action.proposal.destination?.id ?? "" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      change({ pending: false });
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const selectDestination = React.useCallback((scope: string, proposalId: string, destination: string) => {
    update(scope, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.action?.proposal.id === proposalId
          ? { ...message, action: { ...message.action, selectedDestination: destination } }
          : message,
      ),
    }));
  }, [update]);

  const saveMove = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result) return;
    const destination = action.destinations?.find(
      (entry) => (entry.storage_location_id ?? entry.room_id) === action.selectedDestination,
    );
    if (!destination) return;
    const change = (patch: Partial<AssistantActionState>) => update(scope, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.action?.proposal.id === proposalId
          ? { ...message, action: { ...message.action, ...patch } }
          : message,
      ),
    }));
    change({ pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.patch<AssistantActionProposal>(
      `/assistant/actions/proposals/${proposalId}`,
      { room_id: destination.room_id, storage_location_id: destination.storage_location_id },
      { signal: controller.signal },
    ).then((proposal) => {
      if (controller.signal.aborted) return;
      change({ proposal, pending: false, editing: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      change({ pending: false });
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update]);

  const setNameState = React.useCallback((scope: string, proposalId: string, patch: Partial<AssistantActionState>) => {
    update(scope, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.action?.proposal.id === proposalId
          ? { ...message, action: { ...message.action, ...patch } }
          : message,
      ),
    }));
  }, [update]);

  const editName = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result || action.conflict) return;
    const fieldValue = (key: ItemField) => {
      const value = Object.hasOwn(action.proposal.changes, key)
        ? action.proposal.changes[key]
        : action.proposal.before[key];
      return value == null ? "" : String(value);
    };
    const itemDraft: ItemDraft = {
      name: fieldValue("name"), description: fieldValue("description"), brand: fieldValue("brand"),
      model: fieldValue("model"), serial_number: fieldValue("serial_number"), quantity: fieldValue("quantity"),
      condition: fieldValue("condition"),
    };
    setNameState(scope, proposalId, { editing: true, itemDraft });
  }, [setNameState]);

  const setItemField = React.useCallback((scope: string, proposalId: string, field: ItemField, value: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (action?.itemDraft) setNameState(scope, proposalId, { itemDraft: { ...action.itemDraft, [field]: value } });
  }, [setNameState]);

  const saveName = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result || !action.itemDraft) return;
    const draft = action.itemDraft;
    if (!draft.name.trim() || !/^\d+$/.test(draft.quantity) || Number(draft.quantity) > 1_000_000) {
      toast.error("Enter a name and a quantity between 0 and 1,000,000.");
      return;
    }
    const changes: Record<string, string | number | null> = {};
    for (const { key } of ITEM_EDIT_FIELDS) {
      const value = key === "quantity" ? Number(draft[key]) : draft[key].trim() || null;
      const before = action.proposal.before[key] ?? null;
      if (value !== before) changes[key] = value;
    }
    if (!Object.keys(changes).length) {
      toast.error("Choose at least one change.");
      return;
    }
    setNameState(scope, proposalId, { pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.patch<AssistantActionProposal>(
      `/assistant/actions/proposals/${proposalId}`,
      { changes },
      { signal: controller.signal },
    ).then((proposal) => {
      if (!controller.signal.aborted) setNameState(scope, proposalId, { proposal, pending: false, editing: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setNameState(scope, proposalId, { pending: false });
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [setNameState]);

  const editLoan = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result || action.conflict) return;
    const changes = action.proposal.changes;
    const isBorrowing = action.proposal.kind === "borrow";
    const borrower_name = isBorrowing ? changes.owner_name : changes.borrower_name;
    const lent_on = isBorrowing ? changes.borrowed_on : changes.lent_on;
    const { quantity, due_on, item_name } = changes;
    if (typeof borrower_name !== "string" || typeof quantity !== "number" ||
        typeof lent_on !== "string" || (due_on !== null && typeof due_on !== "string") ||
        (isBorrowing && typeof item_name !== "string")) {
      toast.error("The proposal is incomplete. Please try again.");
      return;
    }
    setNameState(scope, proposalId, {
      editing: true,
      loanDraft: {
        borrower_name, quantity: String(quantity), lent_on, due_on: due_on ?? "",
        ...(typeof item_name === "string" ? { item_name } : {}),
      },
    });
  }, [setNameState]);

  const setLoanDraft = React.useCallback((scope: string, proposalId: string, changes: Partial<LoanDraft>) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (action?.loanDraft) setNameState(scope, proposalId, { loanDraft: { ...action.loanDraft, ...changes } });
  }, [setNameState]);

  const saveLoan = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    const draft = action?.loanDraft;
    if (!action || action.pending || action.result || !draft) return;
    const quantity = Number(draft.quantity);
    if (!draft.borrower_name.trim() || (action.proposal.kind === "borrow" && !draft.item_name?.trim()) ||
        !Number.isInteger(quantity) || quantity < 1 ||
        quantity > 1_000_000 || !draft.lent_on || (draft.due_on && draft.due_on < draft.lent_on)) {
      toast.error("Enter a borrower, a valid quantity and valid dates.");
      return;
    }
    setNameState(scope, proposalId, { pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    const changes = action.proposal.kind === "borrow" ? {
      item_name: draft.item_name?.trim(), owner_name: draft.borrower_name.trim(),
      quantity, borrowed_on: draft.lent_on, due_on: draft.due_on || null,
    } : {
      borrower_name: draft.borrower_name.trim(), quantity, lent_on: draft.lent_on, due_on: draft.due_on || null,
    };
    void api.patch<AssistantActionProposal>(
      `/assistant/actions/proposals/${proposalId}`,
      changes,
      { signal: controller.signal },
    ).then((proposal) => {
      if (!controller.signal.aborted) setNameState(scope, proposalId, { proposal, pending: false, editing: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "proposal_stale") {
        setNameState(scope, proposalId, { pending: false, editing: false, conflict: error.message });
      } else {
        setNameState(scope, proposalId, { pending: false });
        toast.error(getApiErrorMessage(error));
      }
    }).finally(() => controllers.current.delete(controller));
  }, [setNameState]);

  const editReturn = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (!action || action.pending || action.result || action.conflict) return;
    const { quantity, returned_on } = action.proposal.changes;
    if (typeof quantity !== "number" || typeof returned_on !== "string") {
      toast.error("The return proposal is incomplete. Please try again.");
      return;
    }
    setNameState(scope, proposalId, { editing: true, returnDraft: { quantity: String(quantity), returned_on } });
  }, [setNameState]);

  const setReturnDraft = React.useCallback((scope: string, proposalId: string, changes: Partial<ReturnDraft>) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    if (action?.returnDraft) setNameState(scope, proposalId, { returnDraft: { ...action.returnDraft, ...changes } });
  }, [setNameState]);

  const saveReturn = React.useCallback((scope: string, proposalId: string) => {
    const action = (conversationsRef.current[scope] ?? EMPTY).messages.find(
      (message) => message.action?.proposal.id === proposalId,
    )?.action;
    const draft = action?.returnDraft;
    if (!action || action.pending || action.result || !draft) return;
    const quantity = Number(draft.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000 || !draft.returned_on) {
      toast.error("Enter a valid quantity and return date.");
      return;
    }
    setNameState(scope, proposalId, { pending: true });
    const controller = new AbortController();
    controllers.current.add(controller);
    void api.patch<AssistantActionProposal>(
      `/assistant/actions/proposals/${proposalId}`,
      { quantity, returned_on: draft.returned_on },
      { signal: controller.signal },
    ).then((proposal) => {
      if (!controller.signal.aborted) setNameState(scope, proposalId, { proposal, pending: false, editing: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "proposal_stale") {
        setNameState(scope, proposalId, { pending: false, editing: false, conflict: error.message });
      } else {
        setNameState(scope, proposalId, { pending: false });
        toast.error(getApiErrorMessage(error));
      }
    }).finally(() => controllers.current.delete(controller));
  }, [setNameState]);

  const value = React.useMemo(
    () => ({ selection, setSelection, conversations, setDraft, reset, ask, clarifyAction, applyAction, cancelAction, refreshAction, editMove, selectDestination, saveMove, editName, setItemField, saveName, editLoan, setLoanDraft, saveLoan, editReturn, setReturnDraft, saveReturn }),
    [selection, conversations, setDraft, reset, ask, clarifyAction, applyAction, cancelAction, refreshAction, editMove, selectDestination, saveMove, editName, setItemField, saveName, editLoan, setLoanDraft, saveLoan, editReturn, setReturnDraft, saveReturn],
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
    clarifyAction: (clarificationId: string, itemId: string, text: string) => store.clarifyAction(scope, clarificationId, { itemId, text }),
    applyAction: (proposalId: string) => store.applyAction(scope, proposalId),
    cancelAction: (proposalId: string) => store.cancelAction(scope, proposalId),
    refreshAction: (proposalId: string) => store.refreshAction(scope, proposalId),
    editMove: (proposalId: string) => store.editMove(scope, proposalId),
    selectDestination: (proposalId: string, destination: string) => store.selectDestination(scope, proposalId, destination),
    saveMove: (proposalId: string) => store.saveMove(scope, proposalId),
    editName: (proposalId: string) => store.editName(scope, proposalId),
    setItemField: (proposalId: string, field: ItemField, value: string) => store.setItemField(scope, proposalId, field, value),
    saveName: (proposalId: string) => store.saveName(scope, proposalId),
    editLoan: (proposalId: string) => store.editLoan(scope, proposalId),
    setLoanDraft: (proposalId: string, changes: Partial<LoanDraft>) => store.setLoanDraft(scope, proposalId, changes),
    saveLoan: (proposalId: string) => store.saveLoan(scope, proposalId),
    editReturn: (proposalId: string) => store.editReturn(scope, proposalId),
    setReturnDraft: (proposalId: string, changes: Partial<ReturnDraft>) => store.setReturnDraft(scope, proposalId, changes),
    saveReturn: (proposalId: string) => store.saveReturn(scope, proposalId),
    ask: (selection: SearchScopeSelection, value: string, regenerate: boolean, session: SessionSnapshot) => {
      const last = conversation.messages[conversation.messages.length - 1];
      const match = value.trim().match(/^(?:the one (?:in|at)|in|at|(?:اون|اونی|آن|اینی)\s+(?:توی|در)|(?:توی|در))\s+(.+?)\s*[.!?؟]?\s*$/iu);
      if (!regenerate && last?.clarification && !last.clarification.resolved && match?.[1]) {
        store.clarifyAction(scope, last.clarification.id, { location: match[1], text: value });
        return;
      }
      store.ask(scope, selection, value, regenerate, session, references);
    },
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
