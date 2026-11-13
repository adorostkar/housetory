import { createPortal } from "react-dom";
import * as React from "react";

import { useSession } from "@/lib/queries";

const AssistantDocumentReview = React.lazy(() =>
  import("@/components/assistant-document-review").then((module) => ({
    default: module.AssistantDocumentReview,
  })),
);

interface DocumentReviewContext {
  activeId: string | null;
  select: (id: string) => void;
  node: HTMLDivElement;
  setVisible: (visible: boolean) => void;
}

const AssistantDocumentsContext = React.createContext<DocumentReviewContext | null>(null);

export function AssistantDocumentsProvider({ children }: { children: React.ReactNode }) {
  const [node] = React.useState(() => window.document.createElement("div"));
  const householdId = useSession().data?.household?.id ?? "";
  const [state, setState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [visible, setVisible] = React.useState(false);
  const activeId = state.householdId === householdId ? state.activeId : null;
  const ids = state.householdId === householdId ? state.ids : [];
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
  const value = React.useMemo(() => ({ activeId, select, node, setVisible }), [activeId, select, node]);
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
