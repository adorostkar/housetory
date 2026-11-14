import { createPortal } from "react-dom";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useCaptureReviews, useSession } from "@/lib/queries";
import { AssistantPhotoProgress } from "@/components/assistant-photo-progress";
import { dispatchAssistantTaskCompletion, type CaptureReview } from "@/lib/assistant-task-events";
import type { AssistantCaptureState } from "@/lib/assistant-conversation";
import type { AiRecognition, ImportDecision, ProposedItem } from "@/lib/types";
import { api, getApiErrorMessage } from "@/lib/api";
import { toast } from "sonner";

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
  activePhotoId: string | null;
  selectPhoto: (id: string) => void;
  photoNode: HTMLDivElement;
  pendingReviews: CaptureReview[];
  reviewsError: boolean;
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
  const [photoNode] = React.useState(() => window.document.createElement("div"));
  const [activePhotoId, setActivePhotoId] = React.useState<string | null>(null);
  const client = useQueryClient();
  const reviews = useCaptureReviews();
  const pendingReviews = reviews.data ?? [];
  const householdId = useSession().data?.household?.id ?? "";
  const selection = React.useRef<{ householdId: string; version: number; photoId: string | null }>({
    householdId, version: 0, photoId: null,
  });
  if (selection.current.householdId !== householdId) {
    selection.current = { householdId, version: selection.current.version + 1, photoId: null };
  }
  const [state, setState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [importState, setImportState] = React.useState<{ householdId: string; activeId: string | null; ids: string[] }>({
    householdId, activeId: null, ids: [],
  });
  const [reviewDraftState, setReviewDraftState] = React.useState<{
    householdId: string;
    drafts: Record<string, ImportReviewDraft>;
  }>({ householdId, drafts: {} });
  const activeId = state.householdId === householdId ? state.activeId : null;
  const ids = [...new Set([
    ...(state.householdId === householdId ? state.ids : []),
    ...pendingReviews.filter((review) => review.kind === "document").map((review) => review.id),
  ])];
  const activeImportId = importState.householdId === householdId ? importState.activeId : null;
  const importIds = [...new Set([
    ...(importState.householdId === householdId ? importState.ids : []),
    ...pendingReviews.filter((review) => review.kind === "import").map((review) => review.id),
  ])];
  const select = React.useCallback((id: string, userInitiated = false) => {
    selection.current = { householdId, version: selection.current.version + 1, photoId: null };
    setActivePhotoId(null);
    setImportState((current) => ({ ...current, activeId: null }));
    if (userInitiated) void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    setState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [client, householdId]);
  const selectImport = React.useCallback((id: string, userInitiated = false) => {
    selection.current = { householdId, version: selection.current.version + 1, photoId: null };
    setActivePhotoId(null);
    setState((current) => ({ ...current, activeId: null }));
    if (userInitiated) void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    setImportState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [client, householdId]);
  const selectPhoto = React.useCallback((id: string) => {
    const version = selection.current.version + 1;
    selection.current = { householdId, version, photoId: id };
    setActivePhotoId(id);
    setState((current) => ({ ...current, activeId: null }));
    setImportState((current) => ({ ...current, activeId: null }));
    void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    void api.get<AiRecognition>(`/ai/recognitions/${id}`).then((recognition) => {
      if (selection.current.householdId !== householdId || selection.current.version !== version) return;
      const importId = recognition.result?._add_items?.import_batch_id;
      if (typeof importId === "string") selectImport(importId);
    }).catch((error: unknown) => toast.error(getApiErrorMessage(error)));
  }, [client, householdId, selectImport]);
  React.useEffect(() => {
    for (const review of pendingReviews) {
      if (!["review", "ready", "failed", "needs_attention", "cancelled"].includes(review.status)) continue;
      const ready = review.status === "review" || review.status === "ready";
      dispatchAssistantTaskCompletion({
        ...review,
        householdId,
        title: ready ? `${review.title} ready for review` : `${review.title} needs attention`,
        description: ready ? "Review the proposals before applying." : "Review available evidence or retry processing.",
      });
    }
  }, [reviews.data, householdId]);
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
    activePhotoId, selectPhoto, photoNode, pendingReviews, reviewsError: reviews.isError,
    getImportReviewDraft, saveImportReviewDraft,
  }), [
    activeId, select, node, activeImportId, selectImport, importNode,
    activePhotoId, selectPhoto, photoNode, reviews.data, reviews.isError,
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
            />
          </React.Suspense>
        </div>
      )), importNode)}
      {createPortal(pendingReviews.filter((review) => review.kind === "photo").map((review) => (
        <div key={`${householdId}:${review.id}`} hidden={review.id !== activePhotoId}>
          <PhotoTask id={review.id} onSelectImport={(id) => {
            if (selection.current.householdId === householdId && selection.current.photoId === review.id) selectImport(id);
            void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
          }} />
        </div>
      )), photoNode)}
    </AssistantDocumentsContext.Provider>
  );
}

function PhotoTask({ id, onSelectImport }: { id: string; onSelectImport: (id: string) => void }) {
  const [capture, setCapture] = React.useState<AssistantCaptureState>({
    id, kind: "photo", recognitionId: id,
  });
  const client = useQueryClient();
  const onChange = React.useCallback((patch: Partial<AssistantCaptureState>) => {
    setCapture((current) => ({ ...current, ...patch }));
    void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
  }, [client]);
  return <AssistantPhotoProgress capture={capture} onChange={onChange} onSelectImport={onSelectImport} />;
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

export function AssistantPhotoSlot() {
  const { photoNode } = useAssistantDocuments();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(photoNode);
    return () => { if (photoNode.parentNode === slot) slot.removeChild(photoNode); };
  }, [photoNode]);
  return <div ref={ref} />;
}
