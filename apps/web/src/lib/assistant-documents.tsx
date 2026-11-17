import { createPortal } from "react-dom";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { fetchCaptureReviews, useCaptureReviews, useSession } from "@/lib/queries";
import { queryKeys } from "@/lib/query-keys";
import { AssistantPhotoProgress } from "@/components/assistant-photo-progress";
import {
  assistantTaskKey, CAPTURE_SETTLED_STATUSES, dispatchAssistantTaskCompletion, type CaptureReview,
} from "@/lib/assistant-task-events";
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
  selectPhoto: (id: string, userInitiated?: boolean) => void;
  photoNode: HTMLDivElement;
  pendingReviews: CaptureReview[];
  dismissReview: (review: CaptureReview) => Promise<void>;
  undoReview: (review: CaptureReview) => Promise<void>;
  retryReview: (review: CaptureReview) => Promise<void>;
  reviewMutationPending: boolean;
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
  const mutationRunning = React.useRef(false);
  const [reviewMutationPending, setReviewMutationPending] = React.useState(false);
  const notificationSnapshot = React.useRef<{
    householdId: string;
    attempts: Map<string, string>;
  } | null>(null);
  const baselineAfter = React.useRef(0);
  const createdCaptures = React.useRef(new Set<string>());
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
  const currentHousehold = React.useRef(householdId);
  currentHousehold.current = householdId;
  // The dismissed list is not kept loaded app-wide. A fresh cached copy answers at
  // once; otherwise the capture opens and is closed again if one fetch shows it
  // was dismissed.
  const isDismissed = React.useCallback((
    kind: CaptureReview["kind"], id: string, deselect: () => void,
  ) => {
    const key = queryKeys.captureReviews(householdId, true);
    const refuse = () => toast.info("This review is dismissed. Use Undo in Dismissed reviews to restore it.");
    const listed = (list: CaptureReview[] | undefined) =>
      Boolean(list?.some((review) => review.kind === kind && review.id === id));
    const state = client.getQueryState<CaptureReview[]>(key);
    if (state?.data && !state.isInvalidated) {
      if (listed(state.data)) refuse();
      return listed(state.data);
    }
    void client.fetchQuery({ queryKey: key, queryFn: () => fetchCaptureReviews(true), retry: false })
      .then((list) => {
        if (currentHousehold.current !== householdId || !listed(list)) return;
        deselect();
        refuse();
      })
      .catch(() => undefined);
    return false;
  }, [client, householdId]);
  const select = React.useCallback((id: string, userInitiated = false) => {
    if (isDismissed("document", id, () => setState((current) => (current.activeId === id ? { ...current, activeId: null } : current)))) return;
    selection.current = { householdId, version: selection.current.version + 1, photoId: null };
    setActivePhotoId(null);
    setImportState((current) => ({ ...current, activeId: null }));
    if (userInitiated) {
      createdCaptures.current.add(`${householdId}:document:${id}`);
      void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    }
    setState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [client, householdId, isDismissed]);
  const selectImport = React.useCallback((id: string, userInitiated = false) => {
    if (isDismissed("import", id, () => setImportState((current) => (current.activeId === id ? { ...current, activeId: null } : current)))) return;
    selection.current = { householdId, version: selection.current.version + 1, photoId: null };
    setActivePhotoId(null);
    setState((current) => ({ ...current, activeId: null }));
    if (userInitiated) {
      createdCaptures.current.add(`${householdId}:import:${id}`);
      void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    }
    setImportState((current) => {
      const currentIds = current.householdId === householdId ? current.ids : [];
      return {
        householdId,
        activeId: id,
        ids: currentIds.includes(id) ? currentIds : [...currentIds, id],
      };
    });
  }, [client, householdId, isDismissed]);
  const selectPhoto = React.useCallback((id: string, userInitiated = false) => {
    if (isDismissed("photo", id, () => setActivePhotoId((current) => (current === id ? null : current)))) return;
    const version = selection.current.version + 1;
    selection.current = { householdId, version, photoId: id };
    setActivePhotoId(id);
    setState((current) => ({ ...current, activeId: null }));
    setImportState((current) => ({ ...current, activeId: null }));
    if (userInitiated) createdCaptures.current.add(`${householdId}:photo:${id}`);
    void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    void api.get<AiRecognition>(`/ai/recognitions/${id}`).then((recognition) => {
      if (selection.current.householdId !== householdId || selection.current.version !== version) return;
      const importId = recognition.result?._add_items?.import_batch_id;
      if (typeof importId === "string") selectImport(importId);
    }).catch((error: unknown) => toast.error(getApiErrorMessage(error)));
  }, [client, householdId, selectImport, isDismissed]);
  const undoReview = React.useCallback(async (review: CaptureReview) => {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setReviewMutationPending(true);
    try {
      await api.post(`/inventory-review/captures/${review.kind}/${review.id}/undo`, {
        dismissal_id: review.dismissal_id ?? null,
      });
      await client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
      toast.success("Review restored");
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      mutationRunning.current = false;
      setReviewMutationPending(false);
    }
  }, [client]);
  const dismissReview = React.useCallback(async (review: CaptureReview) => {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setReviewMutationPending(true);
    try {
      const result = await api.post<CaptureReview>(
        `/inventory-review/captures/${review.kind}/${review.id}/dismiss`,
        { generation: review.generation },
      );
      await client.cancelQueries({ queryKey: ["inventory-review", "captures"] });
      client.setQueryData<CaptureReview[]>(["inventory-review", "captures", householdId],
        (current) => current?.filter((entry) => entry.kind !== review.kind || entry.id !== review.id));
      if (review.kind === "document") setState((current) => ({
        ...current, activeId: current.activeId === review.id ? null : current.activeId,
      }));
      if (review.kind === "import") setImportState((current) => ({
        ...current, activeId: current.activeId === review.id ? null : current.activeId,
      }));
      if (review.kind === "photo" && selection.current.photoId === review.id) {
        selection.current = { householdId, version: selection.current.version + 1, photoId: null };
        setActivePhotoId(null);
      }
      toast.dismiss(assistantTaskKey({ ...review, householdId }));
      await client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
      toast.success("Review dismissed", {
        description: "Source files, history and inventory are unchanged.",
        action: { label: "Undo", onClick: () => void undoReview(result) },
      });
    } catch (error) {
      toast.error(getApiErrorMessage(error));
      await client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
    } finally {
      mutationRunning.current = false;
      setReviewMutationPending(false);
    }
  }, [client, householdId, undoReview]);
  const retryReview = React.useCallback(async (review: CaptureReview) => {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setReviewMutationPending(true);
    try {
      const path = review.kind === "document" ? `/documents/${review.id}/processing/retry`
        : review.kind === "photo" ? `/ai/recognitions/${review.id}/retry`
        : `/imports/${review.id}/${review.retry === "enhancement" ? "enhancement/retry" : "retry"}`;
      await api.post(path);
      await client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
      await client.invalidateQueries({ queryKey: review.kind === "photo" ? queryKeys.recognition(review.id)
        : review.kind === "document" ? queryKeys.document(review.id) : queryKeys.importBatch(review.id) });
      toast.success("New review attempt started");
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      mutationRunning.current = false;
      setReviewMutationPending(false);
    }
  }, [client]);
  React.useEffect(() => {
    const restoreSilently = () => {
      notificationSnapshot.current = null;
      createdCaptures.current.clear();
      baselineAfter.current = Date.now();
      if (document.visibilityState === "visible") {
        void client.invalidateQueries({ queryKey: ["inventory-review", "captures"] });
      }
    };
    window.addEventListener("focus", restoreSilently);
    document.addEventListener("visibilitychange", restoreSilently);
    return () => {
      window.removeEventListener("focus", restoreSilently);
      document.removeEventListener("visibilitychange", restoreSilently);
    };
  }, [client]);
  React.useEffect(() => {
    if (!reviews.data || reviews.isFetching || document.visibilityState !== "visible") return;
    if (reviews.dataUpdatedAt < baselineAfter.current) return;
    const previous = notificationSnapshot.current?.householdId === householdId
      ? notificationSnapshot.current.attempts : null;
    notificationSnapshot.current = {
      householdId,
      attempts: new Map(pendingReviews.map((review) => [assistantTaskKey({ ...review, householdId }), review.status])),
    };
    const created = createdCaptures.current;
    createdCaptures.current = new Set();
    // Restore silently, except tasks explicitly created here during initial loading.
    const terminal = CAPTURE_SETTLED_STATUSES;
    for (const review of pendingReviews) {
      if (review.notify === false) continue;
      if (!previous && !created.has(`${householdId}:${review.kind}:${review.id}`)) continue;
      if (!terminal.includes(review.status)) continue;
      if (terminal.includes(previous?.get(assistantTaskKey({ ...review, householdId })) ?? "")) continue;
      const ready = review.status === "review" || review.status === "ready";
      dispatchAssistantTaskCompletion({
        ...review,
        householdId,
        title: ready ? `${review.title} ready for review` : `${review.title} needs attention`,
        description: ready ? "Review the proposals before applying." : "Review available evidence or retry processing.",
      });
    }
  }, [reviews.data, reviews.dataUpdatedAt, reviews.isFetching, householdId]);
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
    dismissReview, undoReview, retryReview, reviewMutationPending,
    getImportReviewDraft, saveImportReviewDraft,
  }), [
    activeId, select, node, activeImportId, selectImport, importNode,
    activePhotoId, selectPhoto, photoNode, reviews.data, reviews.isError,
    dismissReview, undoReview, retryReview, reviewMutationPending,
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
