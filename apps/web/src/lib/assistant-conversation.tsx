import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import type { ReviewRun, SearchConversationContext, SearchQueryResponse } from "@/lib/types";
import { localDateISO } from "@/lib/utils";
import { actionMessage, createToolRun, mergeToolRun, type AssistantToolRun } from "@/lib/assistant-tools";
import { queryKeys } from "@/lib/query-keys";

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
  attachment?: { name: string; type: string };
  capture?: AssistantCaptureState;
  response?: SearchQueryResponse;
  pageReferences?: AssistantPageReference[];
  action?: AssistantActionState;
  /** A local review started for the user when AI was unavailable. */
  review?: ReviewRun;
  toolRunId?: string;
  toolRun?: AssistantToolRun;
  toolAnswer?: boolean;
}

export interface AssistantCaptureState {
  id: string;
  kind: "items" | "document" | "photo";
  filename?: string;
  documentId?: string;
  recognitionId?: string;
  importId?: string;
  importing?: boolean;
  importError?: string;
  file?: File;
  error?: string;
}

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
  originalRequest: string;
  requestId: string;
  pending: boolean;
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

interface Conversation {
  messages: AssistantMessage[];
  draft: string;
  attachment: File | null;
  attachmentIntent: "photo" | "document" | null;
  attachmentDocumentType: string;
  captureHouseholdId: string;
  capturePending: boolean;
  captureError: string | null;
  turns: SearchTurn[];
  context: SearchConversationContext | null;
  pending: boolean;
  toolParentId: string | null;
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
  setAttachment: (scope: string, file: File | null) => void;
  setAttachmentIntent: (scope: string, value: "photo" | "document" | null) => void;
  setAttachmentDocumentType: (scope: string, value: string) => void;
  setCaptureHouseholdId: (scope: string, value: string) => void;
  setCapturePending: (scope: string, value: boolean) => void;
  setCaptureError: (scope: string, value: string | null) => void;
  openAction: (scope: string, proposal: AssistantActionProposal) => void;
  recordCapture: (
    scope: string,
    userText: string,
    attachment: AssistantMessage["attachment"],
    assistantText: string,
    capture: AssistantCaptureState,
    freshTopic?: boolean,
  ) => void;
  updateCapture: (scope: string, captureId: string, patch: Partial<AssistantCaptureState>) => void;
  reset: (scope: string) => void;
  startFreshTopic: (scope: string) => void;
  ask: (
    scope: string,
    selection: SearchScopeSelection,
    value: string,
    regenerate: boolean,
    session: SessionSnapshot,
    references: AssistantPageReference[],
    freshTopic?: boolean,
    appliedProposalId?: string,
  ) => void;
  applyAction: (scope: string, proposalId: string, onApplied?: () => void) => void;
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
  attachment: null,
  attachmentIntent: null,
  attachmentDocumentType: "",
  captureHouseholdId: "",
  capturePending: false,
  captureError: null,
  turns: [],
  context: null,
  pending: false,
  toolParentId: null,
};

const AssistantConversationContext =
  React.createContext<AssistantConversationContextValue | null>(null);

function ConversationStore({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const invalidateInventory = useInvalidateInventory();
  const invalidateLoans = useInvalidateInventory(["loans"]);
  const invalidateBorrowed = useInvalidateInventory(["borrowed"]);
  const [selection, setSelection] = React.useState<SearchScopeSelection | null>(null);
  const [conversations, setConversations] = React.useState<Record<string, Conversation>>({});
  const conversationsRef = React.useRef(conversations);
  const controllers = React.useRef(new Set<AbortController>());
  const seenRuns = React.useRef(new Set<string>());
  const restoredScopes = React.useRef(new Set<string>());
  const toolRequests = React.useRef(new Map<string, string>());
  const toolScope = selection ? `${selection.householdId}|${selection.propertyId}` : null;
  const waitingForTask = Boolean(toolScope && conversations[toolScope]?.messages.some(
    (message) => message.toolRun && ["queued", "running"].includes(message.toolRun.state),
  ));
  const toolRuns = useQuery({
    queryKey: queryKeys.assistantRuns(selection?.householdId, selection?.propertyId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (selection?.householdId) params.set("household_id", selection.householdId);
      if (selection?.propertyId) params.set("property_id", selection.propertyId);
      return api.get<AssistantToolRun[]>(`/assistant/runs?${params}`).then((runs) => {
        if (!Array.isArray(runs)) throw new Error("Could not restore assistant tasks: invalid history response.");
        return runs;
      });
    },
    enabled: Boolean(selection),
    refetchInterval: (query) => waitingForTask || query.state.data?.some((run) =>
      ["queued", "running"].includes(run.state)) ? 1000 : false,
  });

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

  React.useEffect(() => {
    if (!toolScope || !toolRuns.data?.length) return;
    const firstRestore = !restoredScopes.current.has(toolScope);
    restoredScopes.current.add(toolScope);
    update(toolScope, (current) => {
      // Restored history is older than anything already shown locally, so it goes above.
      const local = firstRestore && !current.messages.some((message) => message.toolRunId)
        ? current.messages : [];
      let messages = local.length ? [] : current.messages;
      for (const [index, run] of toolRuns.data.entries()) {
        const key = `${toolScope}:${run.id}`;
        const existing = messages.some((message) => message.toolRunId === run.id);
        if (seenRuns.current.has(key) && !existing) continue;
        seenRuns.current.add(key);
        const nextKnown = toolRuns.data.slice(index + 1).find((candidate) =>
          messages.some((message) => message.toolRunId === candidate.id));
        const before = nextKnown?.id ?? (firstRestore
          ? current.messages.find((message) => message.toolRunId)?.toolRunId : undefined);
        messages = mergeToolRun(messages, run, before);
      }
      // A card reopened on its own gives way to the same proposal restored with its task.
      const restored = new Set(messages.flatMap((message) =>
        message.action ? [message.action.proposal.id] : []));
      messages = [...messages, ...local.filter((message) =>
        !message.action || !restored.has(message.action.proposal.id))];
      return {
        ...current, messages,
        toolParentId: current.toolParentId ?? (firstRestore ? toolRuns.data.at(-1)?.id ?? null : null),
        pending: messages.some((message) => message.toolRun &&
          ["queued", "running"].includes(message.toolRun.state)),
      };
    });
  }, [toolRuns.data, toolScope, update]);

  // A task can leave a capture or a prepared action behind. Those lists poll slowly
  // while idle, so refresh them as soon as a task appears or changes state.
  const runStates = toolRuns.data?.map((run) => `${run.id}:${run.state}:${run.steps.length}`).join("|");
  React.useEffect(() => {
    if (!runStates) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.captureReviewsAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingActionsAll });
  }, [runStates, queryClient]);

  const setDraft = React.useCallback((scope: string, value: Updater<string>) => {
    update(scope, (current) => ({
      ...current,
      draft: typeof value === "function" ? value(current.draft) : value,
    }));
  }, [update]);

  const setAttachmentDocumentType = React.useCallback((scope: string, value: string) => {
    update(scope, (current) => ({ ...current, attachmentDocumentType: value }));
  }, [update]);

  const setAttachment = React.useCallback((scope: string, file: File | null) => {
    update(scope, (current) => ({ ...current, attachment: file, captureError: null }));
  }, [update]);

  const setAttachmentIntent = React.useCallback((
    scope: string,
    value: "photo" | "document" | null,
  ) => {
    update(scope, (current) => ({ ...current, attachmentIntent: value }));
  }, [update]);

  const setCaptureHouseholdId = React.useCallback((scope: string, value: string) => {
    update(scope, (current) => ({ ...current, captureHouseholdId: value }));
  }, [update]);

  const setCapturePending = React.useCallback((scope: string, value: boolean) => {
    update(scope, (current) => ({ ...current, capturePending: value }));
  }, [update]);

  const setCaptureError = React.useCallback((scope: string, value: string | null) => {
    update(scope, (current) => ({ ...current, captureError: value }));
  }, [update]);

  // Shows a prepared action's review card even when its original task is not loaded.
  const openAction = React.useCallback((scope: string, proposal: AssistantActionProposal) => {
    update(scope, (current) => current.messages.some((message) => message.action?.proposal.id === proposal.id)
      ? current
      : { ...current, messages: [...current.messages, actionMessage(proposal)] });
  }, [update]);

  const pendingActionsChanged = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingActionsAll });
  }, [queryClient]);

  const recordCapture = React.useCallback((
    scope: string,
    userText: string,
    attachment: AssistantMessage["attachment"],
    assistantText: string,
    capture: AssistantCaptureState,
    freshTopic = false,
  ) => {
    update(scope, (current) => ({
      ...current,
      messages: [
        ...current.messages,
        { role: "user", text: userText, ...(attachment ? { attachment } : {}) },
        { role: "assistant", text: assistantText, capture },
      ],
      draft: freshTopic ? current.draft : "",
      attachment: freshTopic ? current.attachment : null,
      attachmentIntent: freshTopic ? current.attachmentIntent : null,
      attachmentDocumentType: freshTopic ? current.attachmentDocumentType : "",
      captureError: null,
      capturePending: false,
      context: freshTopic ? null : current.context,
      toolParentId: freshTopic ? null : current.toolParentId,
      turns: [
        ...(freshTopic ? [] : current.turns),
        { role: "user" as const, content: userText.slice(0, 1200) },
        { role: "assistant" as const, content: assistantText.slice(0, 1200) },
      ].slice(-8),
    }));
  }, [update]);

  const updateCapture = React.useCallback((
    scope: string,
    captureId: string,
    patch: Partial<AssistantCaptureState>,
  ) => {
    update(scope, (current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.capture?.id === captureId
          ? { ...message, capture: { ...message.capture, ...patch } }
          : message,
      ),
    }));
  }, [update]);

  const reset = React.useCallback((scope: string) => {
    update(scope, (current) =>
      current.pending || current.messages.some((message) => message.action?.pending) ? current : EMPTY,
    );
  }, [update]);

  const startFreshTopic = React.useCallback((scope: string) => {
    update(scope, (current) => ({
      ...current,
      turns: [],
      context: null,
      toolParentId: null,
    }));
  }, [update]);

  const ask = React.useCallback((
    scope: string,
    selection: SearchScopeSelection,
    value: string,
    regenerate: boolean,
    session: SessionSnapshot,
    references: AssistantPageReference[],
    freshTopic = false,
    appliedProposalId?: string,
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
    const history = freshTopic ? [] : seededSession ? session.turns : previousTurns;
    const context = freshTopic ? null : regenerate ? previousAnswer?.response?.context : (
      seededSession ? session.context : current.context
    );
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
        draft: !freshTopic && !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        pending: false,
      }));
      if (session.scopeKey === scope) session.record(value, response);
    });
    const request = {
      query: value,
      ...(selection.householdId ? { household_id: selection.householdId } : {}),
      ...(selection.propertyId ? { property_id: selection.propertyId } : {}),
      ...(!freshTopic && current.toolParentId ? { parent_id: current.toolParentId } : {}),
      local_date: localDateISO(),
      ...(appliedProposalId ? { applied_proposal_id: appliedProposalId } : {}),
      page_context: pageReferences.map(({ kind, id }) => ({ kind, id })),
      ...(!freshTopic ? {
        capture_context: [...current.messages].reverse()
          .flatMap<{ kind: AssistantCaptureState["kind"]; id: string }>((message) => {
            const capture = message.capture;
            if (!capture) return [];
            const id = capture.importId ?? capture.documentId ?? capture.recognitionId;
            const kind = capture.importId ? "items" : capture.documentId ? "document" : "photo";
            return id ? [{ kind, id }] : [];
          })
          .slice(0, 6),
      } : {}),
    };
    const requestKey = JSON.stringify([scope, request]);
    const requestId = toolRequests.current.get(requestKey) ?? crypto.randomUUID();
    toolRequests.current.set(requestKey, requestId);
    const execute = createToolRun({ ...request, request_id: requestId }, controller.signal).then((run) => {
      if (!run?.id || !Array.isArray(run.steps)) throw new Error("The assistant returned an invalid task. Your draft is retained.");
      toolRequests.current.delete(requestKey);
      seenRuns.current.add(`${scope}:${run.id}`);
      update(scope, (entry) => {
        const messages = mergeToolRun(regenerate ? entry.messages.slice(0, -2) : entry.messages, run);
        return {
          ...entry, messages,
          pending: messages.some((message) => message.toolRun &&
            ["queued", "running"].includes(message.toolRun.state)),
          toolParentId: run.id,
          draft: !freshTopic && !regenerate && entry.draft.trim() === value ? "" : entry.draft,
        };
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assistantRunsAll });
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "assistant_tools_unavailable") {
        // Local search mode: without the tool engine, typed text is only searched.
        toolRequests.current.delete(requestKey);
        return runSearch();
      }
      if (error instanceof ApiError && error.code === "assistant_household_required") {
        // Assistant tasks work in one household. Across all of them, the lookup the
        // server promises is still available, so answer with it instead of stopping.
        toolRequests.current.delete(requestKey);
        return runSearch().then(() => {
          if (controller.signal.aborted) return;
          toast.info("Searched all your places.", {
            description: "Choose one household in the scope picker to let the assistant prepare changes.",
          });
        });
      }
      throw error;
    });
    void execute.catch((error: unknown) => {
      if (controller.signal.aborted) return;
      update(scope, (entry) => ({ ...entry, pending: false }));
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update, queryClient]);

  const applyAction = React.useCallback((scope: string, proposalId: string, onApplied?: () => void) => {
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
      pendingActionsChanged();
      invalidateInventory();
      invalidateLoans();
      invalidateBorrowed();
      onApplied?.();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "proposal_stale") {
        changeAction((entry) => ({ ...entry, pending: false, conflict: error.message }));
      } else {
        changeAction((entry) => ({ ...entry, pending: false }));
        toast.error(getApiErrorMessage(error));
      }
    }).finally(() => controllers.current.delete(controller));
  }, [invalidateInventory, invalidateLoans, invalidateBorrowed, update, pendingActionsChanged]);

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
      change({ proposal, pending: false, conflict: undefined, editing: false, requestId: proposal.id });
      pendingActionsChanged();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      change({ pending: false });
      toast.error(getApiErrorMessage(error));
    }).finally(() => controllers.current.delete(controller));
  }, [update, pendingActionsChanged]);

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
        pendingActionsChanged();
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        changeAction((entry) => ({ ...entry, pending: false }));
        toast.error(getApiErrorMessage(error));
      }).finally(() => controllers.current.delete(controller));
  }, [update, pendingActionsChanged]);

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
    () => ({
      selection, setSelection, conversations, setDraft, setAttachment, setAttachmentIntent, setAttachmentDocumentType,
      setCaptureHouseholdId, setCapturePending, setCaptureError, recordCapture, openAction, updateCapture,
      reset, startFreshTopic, ask, applyAction, cancelAction, refreshAction, editMove,
      selectDestination, saveMove, editName, setItemField, saveName, editLoan, setLoanDraft,
      saveLoan, editReturn, setReturnDraft, saveReturn,
    }),
    [
      selection, setSelection, conversations, setDraft, setAttachment, setAttachmentIntent, setAttachmentDocumentType,
      setCaptureHouseholdId, setCapturePending, setCaptureError, recordCapture, openAction, updateCapture,
      reset, startFreshTopic, ask, applyAction, cancelAction, refreshAction, editMove,
      selectDestination, saveMove, editName, setItemField, saveName, editLoan, setLoanDraft,
      saveLoan, editReturn, setReturnDraft, saveReturn,
    ],
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
  const updateCapture = React.useCallback(
    (captureId: string, patch: Partial<AssistantCaptureState>) =>
      store.updateCapture(scope, captureId, patch),
    [scope, store.updateCapture],
  );
  return {
    ...conversation,
    question: conversation.draft,
    setQuestion: (value: Updater<string>) => store.setDraft(scope, value),
    setAttachment: (file: File | null) => store.setAttachment(scope, file),
    setAttachmentIntent: (value: "photo" | "document" | null) => store.setAttachmentIntent(scope, value),
    setAttachmentDocumentType: (value: string) => store.setAttachmentDocumentType(scope, value),
    setCaptureHouseholdId: (value: string) => store.setCaptureHouseholdId(scope, value),
    setCapturePending: (value: boolean) => store.setCapturePending(scope, value),
    setCaptureError: (value: string | null) => store.setCaptureError(scope, value),
    openAction: (proposal: AssistantActionProposal) => store.openAction(scope, proposal),
    recordCapture: (
      userText: string,
      attachment: AssistantMessage["attachment"],
      assistantText: string,
      capture: AssistantCaptureState,
      freshTopic?: boolean,
    ) => store.recordCapture(scope, userText, attachment, assistantText, capture, freshTopic),
    updateCapture,
    reset: () => store.reset(scope),
    startFreshTopic: () => store.startFreshTopic(scope),
    applyAction: (proposalId: string, onApplied?: () => void) => store.applyAction(scope, proposalId, onApplied),
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
    ask: (
      selection: SearchScopeSelection,
      value: string,
      regenerate: boolean,
      session: SessionSnapshot,
      freshTopic = false,
      appliedProposalId?: string,
    ) => {
      store.ask(
        scope, selection, value, regenerate, session, freshTopic ? [] : references, freshTopic,
        appliedProposalId,
      );
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
