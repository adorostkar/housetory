import { createPortal } from "react-dom";
import * as React from "react";

import { useSession } from "@/lib/queries";
import type { ImportDecision, ProposedItem } from "@/lib/types";

const AssistantDocumentReview = React.lazy(() =>
  import("@/components/assistant-document-review").then((module) => ({
    default: module.AssistantDocumentReview,
  })),
);

const AssistantImportReview = React.lazy(() =>
  import("@/components/assistant-import-review").then((module) => ({
    default: module.AssistantImportReview,
  })),
);

interface DocumentReviewContext {
  activeId: string | null;
  select: (id: string, userInitiated?: boolean) => void;
  node: HTMLDivElement;
  activeImportId: string | null;
  selectImport: (id: string, userInitiated?: boolean) => void;
  importNode: HTMLDivElement;
  taskDocumentIds: string[];
  taskImportIds: string[];
  getImportReviewDraft: (id: string) => ImportReviewDraft | undefined;
  saveImportReviewDraft: (id: string, draft: ImportReviewDraft) => void;
}

export interface ImportReviewDraft {
  edits: Record<string, ProposedItem>;
  decisions: Record<string, ImportDecision>;
}

const AssistantDocumentsContext = React.createContext<DocumentReviewContext | null>(null);

export function AssistantDocumentsProvider({ children }: { children: React.ReactNode }) {
  const [node] = React.useState(() => window.document.createElement("div"));
  const [importNode] = React.useState(() => window.document.createElement("div"));
  const householdId = useSession().data?.household?.id ?? "";
  const [state, setState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [taskDocumentState, setTaskDocumentState] = React.useState<{ householdId: string; ids: string[] }>({
    householdId, ids: [],
  });
  const [importState, setImportState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [taskImportState, setTaskImportState] = React.useState<{ householdId: string; ids: string[] }>({
    householdId, ids: [],
  });
  const [reviewDraftState, setReviewDraftState] = React.useState<{
    householdId: string;
    drafts: Record<string, ImportReviewDraft>;
  }>({ householdId, drafts: {} });
  const activeId = state.householdId === householdId ? state.activeId : null;
  const ids = state.householdId === householdId ? state.ids : [];
  const activeImportId = importState.householdId === householdId ? importState.activeId : null;
  const importIds = importState.householdId === householdId ? importState.ids : [];
  const taskDocumentIds = taskDocumentState.householdId === householdId ? taskDocumentState.ids : [];
  const taskImportIds = taskImportState.householdId === householdId ? taskImportState.ids : [];
  const select = React.useCallback((id: string, userInitiated = false) => {
    if (userInitiated) setTaskDocumentState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
    setState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [householdId]);
  const selectImport = React.useCallback((id: string, userInitiated = false) => {
    if (userInitiated) setTaskImportState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
    setImportState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [householdId]);
  const getImportReviewDraft = React.useCallback((id: string) =>
    reviewDraftState.householdId === householdId
      ? reviewDraftState.drafts[id]
      : undefined,
  [householdId, reviewDraftState]);
  const saveImportReviewDraft = React.useCallback((id: string, draft: ImportReviewDraft) => {
    setReviewDraftState((current) => ({
      householdId,
      drafts: {
        ...(current.householdId === householdId ? current.drafts : {}),
        [id]: draft,
      },
    }));
  }, [householdId]);
  const value = React.useMemo(() => ({
    activeId, select, node, activeImportId, selectImport, importNode,
    taskDocumentIds, taskImportIds,
    getImportReviewDraft, saveImportReviewDraft,
  }), [
    activeId, select, node, activeImportId, selectImport, importNode,
    taskDocumentIds, taskImportIds,
    getImportReviewDraft, saveImportReviewDraft,
  ]);
  return (
    <AssistantDocumentsContext.Provider value={value}>
      {children}
      {createPortal(ids.map((id) => (
        <div key={id} hidden={id !== activeId}>
          <React.Suspense fallback={<p role="status">Loading document review…</p>}>
            <AssistantDocumentReview
              id={id}
              enabled
              notifyOnReady={taskDocumentIds.includes(id)}
            />
          </React.Suspense>
        </div>
      )), node)}
      {createPortal(importIds.map((id) => (
        <div key={id} hidden={id !== activeImportId}>
          <React.Suspense fallback={<p role="status">Loading item review…</p>}>
            <AssistantImportReview
              id={id}
              enabled
              notifyOnReady={taskImportIds.includes(id)}
            />
          </React.Suspense>
        </div>
      )), importNode)}
    </AssistantDocumentsContext.Provider>
  );
}

export function useAssistantDocuments() {
  const value = React.useContext(AssistantDocumentsContext);
  if (!value) throw new Error("AssistantDocumentsProvider is required");
  return value;
}

export function AssistantDocumentSlot() {
  const { activeId, node } = useAssistantDocuments();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(node);
    return () => {
      if (node.parentNode === slot) slot.removeChild(node);
    };
  }, [node]);
  return <div ref={ref} className={activeId ? "pt-2" : undefined} />;
}

export function AssistantImportSlot() {
  const { activeImportId, importNode } = useAssistantDocuments();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(importNode);
    return () => {
      if (importNode.parentNode === slot) slot.removeChild(importNode);
    };
  }, [importNode]);
  return <div ref={ref} className={activeImportId ? "pt-2" : undefined} />;
}
