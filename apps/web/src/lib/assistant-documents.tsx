import { createPortal } from "react-dom";
import * as React from "react";

import { useSession } from "@/lib/queries";

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
  select: (id: string) => void;
  node: HTMLDivElement;
  setVisible: (visible: boolean) => void;
  activeImportId: string | null;
  selectImport: (id: string) => void;
  importNode: HTMLDivElement;
  setImportVisible: (visible: boolean) => void;
}

const AssistantDocumentsContext = React.createContext<DocumentReviewContext | null>(null);

export function AssistantDocumentsProvider({ children }: { children: React.ReactNode }) {
  const [node] = React.useState(() => window.document.createElement("div"));
  const [importNode] = React.useState(() => window.document.createElement("div"));
  const householdId = useSession().data?.household?.id ?? "";
  const [state, setState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [visible, setVisible] = React.useState(false);
  const [importState, setImportState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [importVisible, setImportVisible] = React.useState(false);
  const activeId = state.householdId === householdId ? state.activeId : null;
  const ids = state.householdId === householdId ? state.ids : [];
  const activeImportId = importState.householdId === householdId ? importState.activeId : null;
  const importIds = importState.householdId === householdId ? importState.ids : [];
  const select = React.useCallback((id: string) => {
    setState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [householdId]);
  const selectImport = React.useCallback((id: string) => {
    setImportState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [householdId]);
  const value = React.useMemo(() => ({
    activeId, select, node, setVisible, activeImportId, selectImport, importNode, setImportVisible,
  }), [activeId, select, node, activeImportId, selectImport, importNode]);
  return (
    <AssistantDocumentsContext.Provider value={value}>
      {children}
      {createPortal(ids.map((id) => (
        <div key={id} hidden={id !== activeId}>
          <React.Suspense fallback={<p role="status">Loading document review…</p>}>
            <AssistantDocumentReview id={id} enabled={visible && id === activeId} />
          </React.Suspense>
        </div>
      )), node)}
      {createPortal(importIds.map((id) => (
        <div key={id} hidden={id !== activeImportId}>
          <React.Suspense fallback={<p role="status">Loading item review…</p>}>
            <AssistantImportReview id={id} enabled={importVisible && id === activeImportId} />
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
  const { activeId, node, setVisible } = useAssistantDocuments();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(node);
    setVisible(true);
    return () => {
      setVisible(false);
      if (node.parentNode === slot) slot.removeChild(node);
    };
  }, [node, setVisible]);
  return <div ref={ref} className={activeId ? "pt-2" : undefined} />;
}

export function AssistantImportSlot() {
  const { activeImportId, importNode, setImportVisible } = useAssistantDocuments();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(importNode);
    setImportVisible(true);
    return () => {
      setImportVisible(false);
      if (importNode.parentNode === slot) slot.removeChild(importNode);
    };
  }, [importNode, setImportVisible]);
  return <div ref={ref} className={activeImportId ? "pt-2" : undefined} />;
}
