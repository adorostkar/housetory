import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  HandCoins,
  Info,
  Loader2,
  MapPin,
  Mic,
  FileText,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { AnswerText } from "@/components/answer-text";
import { AssistantPhotoProgress } from "@/components/assistant-photo-progress";
import { CONDITIONS } from "@/components/item-form-sections";
import { SearchScopeControl } from "@/components/search-scope-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { withHousehold } from "@/lib/household-links";
import { useAiStatus, useCanWrite, useSelectHousehold, useSession } from "@/lib/queries";
import { followUpSuggestions } from "@/lib/assistant-followups";
import { useSearchSession } from "@/lib/search-session";
import { ITEM_EDIT_FIELDS, useAssistantConversation, useAssistantScope } from "@/lib/assistant-conversation";
import { useAssistantPageContext } from "@/lib/assistant-page-context";
import { AssistantDocumentSlot, AssistantImportSlot, useAssistantDocuments } from "@/lib/assistant-documents";
import { useSpeechDictation } from "@/lib/use-speech-dictation";
import type { SearchQueryResponse } from "@/lib/types";
import type { AiRecognition, DocumentRecord, ImportBatchDetail } from "@/lib/types";
import { borrowedLocationPrefix, borrowedPlaceLabel } from "@/lib/borrowed";
import { itemContainer, locationLabel } from "@/lib/utils";
import { DOCUMENT_FILE_ACCEPT, documentFileError, documentFileType, documentUploadFile } from "@/lib/document-files";

const SUGGESTIONS = [
  "Where is my heavy drill?",
  "I bought three Ethernet cables; put them in box 2.",
  "Attach a receipt or photo for review.",
  "Move the ladder to the garage.",
  "Which items have no purchase information?",
  "What is on loan?",
  "What do I need to return?",
  "Who owns the ladder?",
  "What do I have stored in the attic?",
  "Which warranties are expiring soon?",
  "How many suitcases do I own?",
];

function looksLikeItemDescription(value: string) {
  return /^\s*(?:(?:i|we)\s+(?:bought|purchased|got|added|found|picked up)\b|add\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b)/i.test(value);
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

interface AssistantInitialRequest {
  id: string;
  text: string;
  file?: File;
}

export function AssistantPage({
  embedded = false,
  initialRequest,
  onInitialRequestHandled,
}: {
  embedded?: boolean;
  initialRequest?: AssistantInitialRequest | null;
  onInitialRequestHandled?: (id: string) => void;
} = {}) {
  const aiStatus = useAiStatus();
  const canWrite = useCanWrite();
  const {
    activeImportId,
    select: selectDocument,
    selectImport,
  } = useAssistantDocuments();
  const session = useSession();
  const selectHousehold = useSelectHousehold();
  const { references: pageReferences, setReferences: setPageReferences } = useAssistantPageContext();
  const tooManyReferences = pageReferences.length > 12;
  const scope = useAssistantScope();
  const { selection, scopesQuery } = scope;
  const searchSession = useSearchSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const scopeSignature = `${selection.householdId}|${selection.propertyId}`;
  const { messages, question, setQuestion, attachment, setAttachment, attachmentIntent, setAttachmentIntent, captureHouseholdId, setCaptureHouseholdId, capturePending, setCapturePending, captureError, setCaptureError, recordCapture, updateCapture, pending, ask, reset, clarifyAction, applyAction, cancelAction, refreshAction, editMove, selectDestination, saveMove, editName, setItemField, saveName, editLoan, setLoanDraft, saveLoan, editReturn, setReturnDraft, saveReturn } =
    useAssistantConversation(scopeSignature);
  const actionPending = messages.some((message) => message.action?.pending);
  const retainedImportId = [...messages]
    .reverse()
    .find((message) => message.capture?.importId)?.capture?.importId;
  const endRef = React.useRef<HTMLDivElement>(null);
  const autoAskedRef = React.useRef<string | null>(null);
  const handledInitialRequestRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (retainedImportId && retainedImportId !== activeImportId) {
      selectImport(retainedImportId);
    }
  }, [activeImportId, retainedImportId, selectImport]);

  React.useEffect(() => {
    if (embedded) return;
    const value = searchParams.get("q")?.trim() ?? "";
    if (scopesQuery.isPending) return;
    if (value.length < 2 || autoAskedRef.current === value) return;
    autoAskedRef.current = value;
    ask(selection, value, false, searchSession);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
    // The URL is the handoff trigger; ask uses the current messages at
    // the moment the handoff occurs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams, scopesQuery.isPending, embedded]);

  const paneRef = React.useRef<HTMLDivElement>(null);
  const lastAnswerRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const attachmentUrl = useObjectUrl(
    attachment && documentFileType(attachment).startsWith("image/") ? attachment : null,
  );
  const dictation = useSpeechDictation((text) =>
    setQuestion((current) =>
      current.trim() ? `${current.trimEnd()} ${text}` : text,
    ),
  );
  const [nearBottom, setNearBottom] = React.useState(true);
  const [infoOpen, setInfoOpen] = React.useState(false);

  const updateNearBottom = () => {
    const pane = paneRef.current;
    if (!pane) return;
    setNearBottom(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80);
  };

  const jumpToLatest = () => {
    if (typeof endRef.current?.scrollIntoView === "function") {
      endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  };

  React.useEffect(() => {
    const last = messages[messages.length - 1];
    const target =
      last?.role === "assistant" && !pending
        ? lastAnswerRef.current
        : endRef.current;
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: "smooth",
        block: target === endRef.current ? "end" : "start",
      });
    }
  }, [messages, pending]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [question]);

  const multipleHouseholds = scope.scopes.length > 1 || (session.data?.households?.length ?? 0) > 1;
  const captureHousehold = selection.householdId
    || captureHouseholdId
    || (scope.scopes.length === 1 ? scope.scopes[0]?.id : undefined)
    || (!multipleHouseholds ? session.data?.household?.id : undefined);

  const submitCapture = async (value: string) => {
    if (capturePending) return;
    if (!canWrite) {
      setCaptureError("You need member access to add items or attach files.");
      return;
    }
    if (attachment && documentFileError(attachment)) {
      setCaptureError(documentFileError(attachment));
      return;
    }
    const isImage = Boolean(attachment && documentFileType(attachment).startsWith("image/"));
    if (isImage && !attachmentIntent) {
      setCaptureError("Is this an inventory photo or a document/evidence image?");
      return;
    }
    if (!captureHousehold || (multipleHouseholds && !selection.householdId && !captureHouseholdId)) {
      setCaptureError("Choose the household that should receive this capture.");
      return;
    }

    setCapturePending(true);
    setCaptureError(null);
    try {
      if (session.data?.household?.id !== captureHousehold) {
        await selectHousehold.mutateAsync(captureHousehold);
      }
      if (attachment) {
        const file = documentUploadFile(attachment);
        const attachmentMeta = { name: file.name, type: documentFileType(file) };
        if (isImage && attachmentIntent === "photo") {
          const form = new FormData();
          form.append("file", file);
          form.append("text", value);
          if (selection.propertyId) form.append("property_id", selection.propertyId);
          const recognition = await api.postForm<AiRecognition>("/ai/recognitions", form);
          recordCapture(
            value || `Inventory photo: ${file.name}`,
            attachmentMeta,
            "Interpreting the inventory photo. Review the item proposal here before applying it.",
            {
              id: crypto.randomUUID(),
              kind: "photo",
              filename: file.name,
              recognitionId: recognition.id,
            },
          );
          return;
        }

        const form = new FormData();
        form.append("file", file);
        form.append("title", file.name.replace(/\.[^.]+$/, "").slice(0, 200));
        const textLower = value.toLowerCase();
        const documentType = /invoice/.test(textLower)
          ? "invoice"
          : /receipt|proof of purchase/.test(textLower)
            ? "receipt"
            : "other";
        form.append("document_type", documentType);
        if (value) form.append("notes", value);
        const document = await api.postForm<DocumentRecord>("/documents", form);
        selectDocument(document.id);
        setPageReferences([{ kind: "document", id: document.id, name: document.title }]);
        recordCapture(
          value || `Attached ${file.name}`,
          attachmentMeta,
          "Document attached. Progress, extracted details and review are shown below.",
          {
            id: crypto.randomUUID(),
            kind: "document",
            filename: file.name,
            documentId: document.id,
          },
        );
        return;
      }

      const form = new FormData();
      form.append("text", value);
      form.append("title", "Assistant item description");
      if (selection.propertyId) form.append("property_id", selection.propertyId);
      const batch = await api.postForm<ImportBatchDetail>("/imports", form);
      selectImport(batch.id);
      recordCapture(
        value,
        undefined,
        "Preparing item proposals. Edit the details and destination below, then approve to add them.",
        { id: crypto.randomUUID(), kind: "items", importId: batch.id },
      );
    } catch (error) {
      setCaptureError(getApiErrorMessage(error));
      setCapturePending(false);
    }
  };

  const submitValue = (value: string, freshRequest = false) => {
    if (pending || tooManyReferences || capturePending) return;
    if (attachment || (canWrite && looksLikeItemDescription(value))) {
      if (!attachment && value.length < 2) return;
      dictation.stop();
      void submitCapture(value);
      return;
    }
    if (value.length < 2) return;
    dictation.stop();
    ask(
      selection,
      value,
      false,
      freshRequest
        ? { scopeKey: scopeSignature, turns: [], context: null, record: () => undefined }
        : searchSession,
    );
  };

  React.useEffect(() => {
    if (
      !embedded ||
      !initialRequest ||
      scopesQuery.isPending ||
      pending ||
      capturePending ||
      actionPending ||
      handledInitialRequestRef.current === initialRequest.id
    ) return;
    handledInitialRequestRef.current = initialRequest.id;
    reset();
    if (searchSession.scopeKey === scopeSignature) searchSession.reset();
    if (initialRequest.file) {
      setAttachment(initialRequest.file);
      setAttachmentIntent(
        documentFileType(initialRequest.file).startsWith("image/") ? null : "document",
      );
      setQuestion(initialRequest.text);
      setCaptureError(null);
    } else if (initialRequest.text.trim()) {
      submitValue(initialRequest.text.trim(), true);
    }
    onInitialRequestHandled?.(initialRequest.id);
  }, [
    actionPending,
    capturePending,
    embedded,
    initialRequest,
    onInitialRequestHandled,
    pending,
    reset,
    scopeSignature,
    searchSession.reset,
    searchSession.scopeKey,
    scopesQuery.isPending,
    selection,
    setAttachment,
    setAttachmentIntent,
    setCaptureError,
    setQuestion,
    submitValue,
  ]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    submitValue(question.trim());
  };

  const newConversation = () => {
    if (pending || actionPending) return;
    reset();
    if (searchSession.scopeKey === scopeSignature) searchSession.reset();
    autoAskedRef.current = null;
  };

  const askSuggestion = (value: string) => {
    if (tooManyReferences) return;
    setQuestion("");
    submitValue(value);
  };

  const regenerateLatest = () => {
    if (pending) return;
    const last = messages[messages.length - 1];
    const previous = messages[messages.length - 2];
    if (last?.role !== "assistant" || previous?.role !== "user") return;
    ask(selection, previous.text, true, searchSession);
  };

  const status = aiStatus.data;
  const lastResponse = [...messages]
    .reverse()
    .find((message) => message.response)?.response;
  const displayStatus = lastResponse?.ai_status ?? status;
  const allPlacesScope =
    !selection.householdId || Boolean(selection.propertyId);
  const modeLabel = lastResponse
    ? lastResponse.mode === "ai"
      ? "AI-assisted answer"
      : lastResponse.mode === "direct"
        ? "Direct inventory lookup"
        : displayStatus?.configured
          ? "AI unavailable · used basic mode"
          : "AI off · local answer"
    : "AI when needed · grounded in records";

  return (
    <div
      className="relative flex h-full min-h-0 flex-col animate-fade-up"
      onDragOver={(event) => {
        if (!canWrite || !Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length > 1) {
          setCaptureError("Attach one file at a time. Your draft is unchanged.");
          return;
        }
        const file = event.dataTransfer.files[0] ?? null;
        const error = file ? documentFileError(file) : null;
        if (error) {
          setCaptureError(error);
          return;
        }
        setAttachment(file ? documentUploadFile(file) : null);
        setAttachmentIntent(file && documentFileType(file).startsWith("image/") ? null : "document");
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-ring bg-background/80 text-sm font-medium">
          Drop a supported file to attach it
        </div>
      )}
      <div className="shrink-0 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="eyebrow mb-1 hidden sm:block">Intelligence</p>
            <h1 className="display-title !text-[1.6rem] sm:!text-[2rem]">
              Assistant
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-3 sm:h-10 sm:px-5"
              onClick={newConversation}
              aria-label="New conversation"
              disabled={pending || actionPending || messages.length === 0}
            >
              <RotateCcw />
              <span className="sm:hidden">New chat</span>
              <span className="hidden sm:inline">New conversation</span>
            </Button>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center gap-2">
          <SearchScopeControl scope={scope} compact />
          {pageReferences.length > 0 && (
            <div className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-2 py-1 text-xs" aria-label="Current assistant context">
              <span className="min-w-0 truncate">
                {pageReferences.length === 1 && pageReferences[0]
                  ? `${pageReferences[0].kind}: ${pageReferences[0].name}`
                  : `Selection: ${pageReferences.length} items`}
              </span>
              {pageReferences.length > 1 && (
                <details className="relative shrink-0">
                  <summary className="cursor-pointer underline underline-offset-2">View</summary>
                  <ul className="surface absolute left-0 top-full z-40 mt-1 max-h-32 w-56 overflow-y-auto p-2 text-xs shadow-lg">
                    {pageReferences.map((ref) => (
                      <li key={`${ref.kind}:${ref.id}`} className="break-words py-1">{ref.name}</li>
                    ))}
                  </ul>
                </details>
              )}
              <button type="button" className="shrink-0 rounded px-1" onClick={() => setPageReferences([])} aria-label="Clear assistant context">
                ×
              </button>
            </div>
          )}
          <Badge
            variant={
              lastResponse?.mode === "ai"
                ? "brass"
                : lastResponse?.mode === "fallback"
                  ? "outline"
                  : "sage"
            }
          >
            <Sparkles className="size-3" />
            {modeLabel}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 sm:h-8"
            aria-expanded={infoOpen}
            aria-controls="assistant-info"
            onClick={() => setInfoOpen((open) => !open)}
          >
            <Info />
            Privacy &amp; model
          </Button>
          {infoOpen && (
            <div
              id="assistant-info"
              className="surface absolute left-0 top-full z-40 mt-2 w-[min(32rem,100%)] space-y-1.5 p-3.5 text-2xs leading-relaxed text-muted-foreground shadow-lg"
            >
              <p>
                {displayStatus?.available
                  ? "Provider available for this scope."
                  : displayStatus?.configured
                    ? "Provider configured; direct search still works."
                    : "No model configured; direct grounded results stay available."}
              </p>
              {displayStatus?.data_leaves_server && (
                <Badge variant="brass">
                  Remote transmission enabled with consent
                </Badge>
              )}
              <p>
                {allPlacesScope
                  ? "All-my-places answers are interpreted one household at a time using only that household's configured provider and consent. Read-only deterministic retrieval remains available when a household has no provider; no household's records are sent through another household's provider."
                  : (displayStatus?.privacy_note ??
                    "Answers use authorised household records.")}
              </p>
              {status?.model && (
                <p>
                  Model: <span className="font-medium">{status.model}</span>
                  {status.provider_label ? ` · ${status.provider_label}` : ""}
                </p>
              )}
              {status?.error && <p className="text-brass">{status.error}</p>}
              <p>
                Changes require your review and explicit Apply. The assistant
                cannot delete items.{" "}
                <Link
                  to="/settings/ai"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  AI settings
                </Link>
              </p>
            </div>
          )}
        </div>
        {tooManyReferences && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            Select at most 12 items to ask about the selection, or clear the assistant context.
          </p>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={paneRef}
          onScroll={updateNearBottom}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="h-full overflow-y-auto overscroll-contain pb-2"
        >
          <div className="mx-auto w-full max-w-5xl space-y-4">
            {messages.length === 0 && !pending && (
              <div className="flex flex-col items-center px-2 py-10 text-center">
                <Bot className="size-6 text-brass" strokeWidth={1.6} />
                <h2 className="mt-2 font-display text-[1.35rem] tracking-[-0.025em]">
                  What would you like to do?
                </h2>
                <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
                  Ask a question, request an inventory change, describe items to
                  add, or attach a document or photo. You review every change
                  before it is saved.
                </p>
              </div>
            )}
            {messages.map((message, index) =>
              message.role === "user" ? (
                <div key={index} className="flex justify-end">
                  <div
                    dir="auto"
                    className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-start text-sm leading-relaxed text-primary-foreground"
                  >
                    {message.text}
                    {message.attachment && (
                      <span className="mt-2 flex max-w-full items-center gap-2 rounded-lg bg-primary-foreground/10 px-2.5 py-2 text-xs">
                        <FileText className="size-4 shrink-0" />
                        <span className="truncate">{message.attachment.name}</span>
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  key={index}
                  ref={
                    index === messages.length - 1 ? lastAnswerRef : undefined
                  }
                  className="scroll-mt-2"
                >
                  {message.capture ? (
                    <div className="surface space-y-3 p-4" aria-label="Assistant capture status">
                      <p dir="auto" className="text-sm">{message.text}</p>
                      {message.capture.kind === "photo" && (
                        <AssistantPhotoProgress
                          capture={message.capture}
                          onChange={(patch) => updateCapture(message.capture!.id, patch)}
                          onSelectImport={selectImport}
                        />
                      )}
                    </div>
                  ) : message.action ? (
                    <div className="surface space-y-3 p-5" aria-label="Action review">
                      <p dir="auto" className="text-sm">{message.text}</p>
                      <p className="text-xs text-muted-foreground">Original request</p>
                      <p dir="auto" className="whitespace-pre-wrap break-words text-sm">{message.action.originalRequest}</p>
                      <p className="break-words text-xs text-muted-foreground">
                        Scope: {message.action.proposal.scope_label}
                      </p>
                      {message.action.clarificationLabel && (
                        <p className="break-words text-xs text-muted-foreground">
                          Selected: {message.action.clarificationLabel}
                        </p>
                      )}
                      <div className="space-y-1">
                        {message.action.proposal.targets.map((target) => (
                          <p key={target.id} className="break-words text-sm font-medium">{target.name}</p>
                        ))}
                        {message.action.proposal.destination && (
                          <p className="break-words text-sm">{message.action.proposal.destination.name}</p>
                        )}
                        {message.action.proposal.kind === "edit_item" && (
                          <>
                            <dl className="space-y-1 text-sm">
                              {ITEM_EDIT_FIELDS.filter(({ key }) => Object.hasOwn(message.action!.proposal.changes, key)).map(({ key, label }) => (
                                <div key={key} className="break-words">
                                  <dt className="font-medium">{label}</dt>
                                  <dd>From: {String(message.action!.proposal.before[key] ?? "Not set")}</dd>
                                  <dd>To: <span>{String(message.action!.proposal.changes[key] ?? "Not set")}</span></dd>
                                </div>
                              ))}
                            </dl>
                            {message.action.proposal.targets[0] && (
                              <p className="text-xs text-muted-foreground">
                                For other fields, use the{" "}
                                <Link
                                  className="underline"
                                  to={withHousehold(`/items/${message.action.proposal.targets[0].id}/edit`, selection.householdId || undefined)}
                                >
                                  Open full item editor
                                </Link>. This proposal is separate.
                              </p>
                            )}
                          </>
                        )}
                        {message.action.proposal.kind === "lend" && (
                          <dl className="grid grid-cols-2 gap-2 text-sm">
                            <dt>Borrower</dt><dd className="break-words">{String(message.action.proposal.changes.borrower_name ?? "")}</dd>
                            <dt>Quantity</dt><dd>{String(message.action.proposal.changes.quantity ?? "")}</dd>
                            <dt>Lent on</dt><dd>{String(message.action.proposal.changes.lent_on ?? "")}</dd>
                            <dt>Due on</dt><dd>{String(message.action.proposal.changes.due_on ?? "Not set")}</dd>
                          </dl>
                        )}
                        {message.action.proposal.kind === "borrow" && (
                          <dl className="grid grid-cols-2 gap-2 text-sm">
                            <dt>Item</dt><dd className="break-words">{String(message.action.proposal.changes.item_name ?? "")}</dd>
                            <dt>Owner</dt><dd className="break-words">{String(message.action.proposal.changes.owner_name ?? "")}</dd>
                            <dt>Quantity</dt><dd>{String(message.action.proposal.changes.quantity ?? "")}</dd>
                            <dt>Borrowed on</dt><dd>{String(message.action.proposal.changes.borrowed_on ?? "")}</dd>
                            <dt>Due on</dt><dd>{String(message.action.proposal.changes.due_on ?? "Not set")}</dd>
                          </dl>
                        )}
                        {(message.action.proposal.kind === "return_loan" || message.action.proposal.kind === "return_borrowed") && (
                          <dl className="grid grid-cols-2 gap-2 text-sm">
                            <dt>Direction</dt><dd>{message.action.proposal.kind === "return_loan" ? "Returned by borrower" : "Returned to owner"}</dd>
                            <dt>Return quantity</dt><dd>{String(message.action.proposal.changes.quantity ?? "")}</dd>
                            <dt>Outstanding</dt><dd>{String(message.action.proposal.before.outstanding_quantity ?? "")}</dd>
                            <dt>Returned on</dt><dd>{String(message.action.proposal.changes.returned_on ?? "")}</dd>
                          </dl>
                        )}
                      </div>
                      {message.action.result ? (
                        <p role="status" className="text-sm">{message.action.result}</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {message.action.conflict && (
                            <>
                              <p role="alert" className="w-full text-sm text-destructive">{message.action.conflict}</p>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={message.action.pending}
                                onClick={() => message.action && refreshAction(message.action.proposal.id)}
                              >
                                Refresh proposal
                              </Button>
                            </>
                          )}
                          {message.action.proposal.kind === "return_loan" || message.action.proposal.kind === "return_borrowed" ? (
                            message.action.editing && message.action.returnDraft ? (
                              <>
                                <label className="w-full text-sm">Return quantity
                                  <input type="number" min={1} max={1000000} className="mt-1 w-full rounded-md border border-border bg-background p-2" value={message.action.returnDraft.quantity} onChange={(event) => message.action && setReturnDraft(message.action.proposal.id, { quantity: event.target.value })} />
                                </label>
                                <label className="w-full text-sm">Returned on
                                  <input type="date" className="mt-1 w-full rounded-md border border-border bg-background p-2" value={message.action.returnDraft.returned_on} onChange={(event) => message.action && setReturnDraft(message.action.proposal.id, { returned_on: event.target.value })} />
                                </label>
                                <Button type="button" disabled={message.action.pending} onClick={() => message.action && saveReturn(message.action.proposal.id)}>Save return</Button>
                              </>
                            ) : (
                              <Button type="button" variant="outline" disabled={message.action.pending || Boolean(message.action.conflict)} onClick={() => message.action && editReturn(message.action.proposal.id)}>Edit return</Button>
                            )
                          ) : message.action.proposal.kind === "lend" || message.action.proposal.kind === "borrow" ? (
                            message.action.editing && message.action.loanDraft ? (
                              <>
                                {message.action.proposal.kind === "borrow" && (
                                  <label className="w-full text-sm">Item name
                                    <input className="mt-1 w-full rounded-md border border-border bg-background p-2" maxLength={200} value={message.action.loanDraft.item_name ?? ""} onChange={(event) => message.action && setLoanDraft(message.action.proposal.id, { item_name: event.target.value })} />
                                  </label>
                                )}
                                <label className="w-full text-sm">{message.action.proposal.kind === "borrow" ? "Owner" : "Borrower"}
                                  <input className="mt-1 w-full rounded-md border border-border bg-background p-2" maxLength={120} value={message.action.loanDraft.borrower_name} onChange={(event) => message.action && setLoanDraft(message.action.proposal.id, { borrower_name: event.target.value })} />
                                </label>
                                <label className="w-full text-sm">Quantity
                                  <input type="number" min={1} max={1000000} className="mt-1 w-full rounded-md border border-border bg-background p-2" value={message.action.loanDraft.quantity} onChange={(event) => message.action && setLoanDraft(message.action.proposal.id, { quantity: event.target.value })} />
                                </label>
                                <label className="w-full text-sm">{message.action.proposal.kind === "borrow" ? "Borrowed on" : "Lent on"}
                                  <input type="date" className="mt-1 w-full rounded-md border border-border bg-background p-2" value={message.action.loanDraft.lent_on} onChange={(event) => message.action && setLoanDraft(message.action.proposal.id, { lent_on: event.target.value })} />
                                </label>
                                <label className="w-full text-sm">Due on
                                  <input type="date" className="mt-1 w-full rounded-md border border-border bg-background p-2" value={message.action.loanDraft.due_on} onChange={(event) => message.action && setLoanDraft(message.action.proposal.id, { due_on: event.target.value })} />
                                </label>
                                <Button type="button" disabled={message.action.pending} onClick={() => message.action && saveLoan(message.action.proposal.id)}>{message.action.proposal.kind === "borrow" ? "Save borrowing" : "Save loan"}</Button>
                              </>
                            ) : (
                              <Button type="button" variant="outline" disabled={message.action.pending || Boolean(message.action.conflict)} onClick={() => message.action && editLoan(message.action.proposal.id)}>{message.action.proposal.kind === "borrow" ? "Edit borrowing" : "Edit loan"}</Button>
                            )
                          ) : message.action.proposal.kind === "edit_item" ? (
                            message.action.editing && message.action.itemDraft ? (
                              <>
                                {ITEM_EDIT_FIELDS.map((field) => (
                                  <label key={field.key} className="w-full text-sm">
                                    {field.label}
                                    {field.key === "condition" ? (
                                      <select
                                        className="mt-1 w-full rounded-md border border-border bg-background p-2"
                                        value={message.action!.itemDraft!.condition}
                                        onChange={(event) => message.action && setItemField(message.action.proposal.id, "condition", event.target.value)}
                                      >
                                        <option value="" disabled>Choose condition</option>
                                        {CONDITIONS.map((condition) => <option key={condition} value={condition}>{condition}</option>)}
                                      </select>
                                    ) : (
                                      <input
                                        type={field.key === "quantity" ? "number" : "text"}
                                        min={field.key === "quantity" ? 0 : undefined}
                                        max={field.key === "quantity" ? 1000000 : undefined}
                                        maxLength={"maxLength" in field ? field.maxLength : undefined}
                                        className="mt-1 w-full rounded-md border border-border bg-background p-2"
                                        value={message.action!.itemDraft![field.key]}
                                        onChange={(event) => message.action && setItemField(message.action.proposal.id, field.key, event.target.value)}
                                      />
                                    )}
                                  </label>
                                ))}
                                <Button type="button" disabled={message.action.pending || !message.action.itemDraft.name.trim()} onClick={() => message.action && saveName(message.action.proposal.id)}>
                                  Save change
                                </Button>
                              </>
                            ) : (
                              <Button type="button" variant="outline" disabled={message.action.pending || Boolean(message.action.conflict)} onClick={() => message.action && editName(message.action.proposal.id)}>
                                Edit change
                              </Button>
                            )
                          ) : message.action.editing ? (
                            <>
                              <label className="w-full text-sm">
                                Destination
                                <select
                                  aria-label="Destination"
                                  className="mt-1 w-full rounded-md border border-border bg-background p-2"
                                  value={message.action.selectedDestination ?? ""}
                                  onChange={(event) => message.action && selectDestination(message.action.proposal.id, event.target.value)}
                                >
                                  <option value="">Choose a destination</option>
                                  {message.action.destinations?.map((destination) => (
                                    <option
                                      key={destination.storage_location_id ?? destination.room_id}
                                      value={destination.storage_location_id ?? destination.room_id}
                                    >
                                      {destination.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <Button
                                type="button"
                                disabled={message.action.pending || !message.action.selectedDestination}
                                onClick={() => message.action && saveMove(message.action.proposal.id)}
                              >
                                Save destination
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={message.action.pending || Boolean(message.action.conflict)}
                              onClick={() => message.action && editMove(message.action.proposal.id)}
                            >
                              Edit destination
                            </Button>
                          )}
                          <Button
                            type="button"
                            disabled={message.action.pending || message.action.editing || Boolean(message.action.conflict)}
                            onClick={() => message.action && applyAction(message.action.proposal.id)}
                          >
                            Apply
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={message.action.pending}
                            onClick={() => message.action && cancelAction(message.action.proposal.id)}
                          >
                            Cancel proposal
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <AssistantAnswer
                        response={message.response}
                        text={message.text}
                        onRegenerate={
                          index === messages.length - 1 ? regenerateLatest : undefined
                        }
                        regenerateDisabled={pending}
                      />
                      {message.response && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Read-only answer. No changes were made.
                        </p>
                      )}
                      {message.clarification && (
                        <div className="mt-2 flex flex-wrap gap-2" aria-label="Choose an item">
                          {message.clarification.choices.map((choice) => (
                            <Button
                              key={choice.id}
                              type="button"
                              variant="outline"
                              className="h-auto max-w-full whitespace-normal text-start"
                              disabled={pending || message.clarification?.resolved}
                              onClick={() => message.clarification && clarifyAction(message.clarification.id, choice.id, choice.name)}
                            >
                              {choice.name}
                            </Button>
                          ))}
                        </div>
                      )}
                      {message.fallback && (
                        <Link className="mt-2 inline-flex text-sm underline" to={message.fallback.href}>
                          {message.fallback.label}
                        </Link>
                      )}
                    </>
                  )}
                  {!message.action && !message.clarification && index === messages.length - 1 && !pending && (
                    <FollowUps
                      suggestions={followUpSuggestions(
                        message.response,
                        messages[index - 1]?.text ?? "",
                      )}
                      onAsk={askSuggestion}
                      disabled={tooManyReferences}
                    />
                  )}
                </div>
              ),
            )}
            {pending && (
              <div className="surface flex items-center gap-3 p-5 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Retrieving current records across your places…
              </div>
            )}
            <AssistantDocumentSlot />
            <AssistantImportSlot />
            <div ref={endRef} />
          </div>
        </div>
        {!nearBottom && messages.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-3 rounded-full bg-card shadow-lg"
          >
            <ArrowDown />
            Jump to latest
          </Button>
        )}
      </div>

      <div className="shrink-0 pt-2">
        <div className="mx-auto w-full max-w-5xl">
          {messages.length === 0 && !pending && (
            <div
              className="-mx-1 mb-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto px-1 pb-1"
              aria-label="Suggested questions"
            >
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={tooManyReferences}
                  onClick={() => askSuggestion(suggestion)}
                  className="rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <section className="surface bg-card/95 p-2.5 shadow-lg sm:p-3">
            {multipleHouseholds && !selection.householdId && (attachment || looksLikeItemDescription(question)) && (
              <label className="mb-2 block text-xs text-muted-foreground">
                Destination household
                <Select
                  aria-label="Destination household"
                  className="mt-1 h-11 w-full"
                  value={captureHouseholdId}
                  disabled={capturePending}
                  onChange={(event) => setCaptureHouseholdId(event.target.value)}
                >
                  <option value="">Choose a household</option>
                  {scope.scopes.map((household) => (
                    <option key={household.id} value={household.id}>{household.name}</option>
                  ))}
                </Select>
              </label>
            )}
            {attachment && (
              <div className="mb-2 flex items-center gap-3 rounded-xl border border-border/80 bg-secondary/30 p-2.5">
                {attachmentUrl ? (
                  <img src={attachmentUrl} alt={`Preview of ${attachment.name}`} className="size-12 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary">
                    <FileText className="size-5 text-muted-foreground" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{attachment.name}</p>
                  <p className="text-2xs text-muted-foreground">{Math.ceil(attachment.size / 1024)} KB</p>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove attachment"
                  className="size-11"
                  disabled={capturePending}
                  onClick={() => {
                    setAttachment(null);
                    setAttachmentIntent(null);
                    setCaptureError(null);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </Button>
              </div>
            )}
            {attachment && documentFileType(attachment).startsWith("image/") && (
              <fieldset className="mb-2 rounded-xl border border-border/70 px-3 py-2">
                <legend className="px-1 text-xs text-muted-foreground">How should I use this image?</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  <label className="inline-flex min-h-11 items-center gap-2 text-xs">
                    <input type="radio" name="assistant-image-intent" checked={attachmentIntent === "photo"} onChange={() => { setAttachmentIntent("photo"); setCaptureError(null); }} />
                    Inventory photo
                  </label>
                  <label className="inline-flex min-h-11 items-center gap-2 text-xs">
                    <input type="radio" name="assistant-image-intent" checked={attachmentIntent === "document"} onChange={() => { setAttachmentIntent("document"); setCaptureError(null); }} />
                    Document or evidence
                  </label>
                </div>
              </fieldset>
            )}
            {multipleHouseholds && !selection.householdId && (attachment || looksLikeItemDescription(question)) && !captureHouseholdId && (
              <p className="mb-2 text-xs text-brass">Choose a destination household; All my places will not select one automatically.</p>
            )}
            {captureError && <p role="alert" className="mb-2 text-xs text-destructive">{captureError}</p>}
            <form
              onSubmit={submit}
              onPaste={(event) => {
                if (attachment || capturePending) return;
                const files = Array.from(event.clipboardData.files);
                if (files.length === 0) return;
                event.preventDefault();
                if (files.length > 1) {
                  setCaptureError("Attach one file at a time. Your draft is unchanged.");
                  return;
                }
                const file = files[0]!;
                const error = documentFileError(file);
                if (error) {
                  setCaptureError(error);
                  return;
                }
                setAttachment(documentUploadFile(file));
                setAttachmentIntent(documentFileType(file).startsWith("image/") ? null : "document");
                setCaptureError(null);
              }}
            >
              <div className="flex items-end gap-2">
                <Textarea
                  ref={textareaRef}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="Ask, add items…"
                  aria-label="Ask the Housetory assistant"
                  rows={1}
                  maxLength={2000}
                  className="max-h-40 min-h-11 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={DOCUMENT_FILE_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    const error = file ? documentFileError(file) : null;
                    if (error) setCaptureError(error);
                    else if (file) {
                      setAttachment(documentUploadFile(file));
                      setAttachmentIntent(documentFileType(file).startsWith("image/") ? null : "document");
                    }
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Attach a file"
                  title="Attach a PDF or image"
                  className="size-11 shrink-0"
                  disabled={!canWrite || capturePending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip />
                </Button>
                {dictation.supported && (
                  <Button
                    type="button"
                    size="icon"
                    variant={dictation.listening ? "default" : "ghost"}
                    aria-label={
                      dictation.listening ? "Stop dictation" : "Dictate question"
                    }
                    aria-pressed={dictation.listening}
                    onClick={dictation.toggle}
                    className={dictation.listening ? "animate-pulse" : undefined}
                  >
                    <Mic />
                  </Button>
                )}
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send question"
                  disabled={pending || capturePending || tooManyReferences || (!attachment && question.trim().length < 2)}
                >
                  {pending || capturePending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Send />
                  )}
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

function contextualLink(response: SearchQueryResponse): string | null {
  let path: string | null = null;
  if (response.tool === "find_missing_information") {
    const criterion = String(response.facts.criterion ?? "");
    if (criterion === "missing_purchase") path = "/items?purchase_info=missing";
    else if (criterion === "missing_purchase_date") {
      path = "/items?purchase_info=missing_date";
    } else if (criterion === "missing_purchase_price") {
      path = "/items?purchase_info=missing_price";
    } else if (criterion === "purchase_unknown") {
      path = "/items?purchase_info=unknown";
    } else if (criterion === "purchase_not_applicable") {
      path = "/items?purchase_info=not_applicable";
    } else path = "/items";
  } else if (
    response.tool === "list_outstanding_loans" ||
    response.tool === "list_borrowed_items" ||
    response.tool === "find_borrowed_owner"
  )
    path = "/loans";
  else if (response.tool === "get_warranty_status") path = "/warranties";
  else if (response.tool === "search_documents") path = "/documents";
  else if (response.tool === "get_purchase_history") path = "/purchases";
  if (!path) return null;
  if ((response.households?.length ?? 0) > 1 || response.property) return null;
  return withHousehold(path, response.households?.[0]?.id);
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function FollowUps({
  suggestions,
  onAsk,
  disabled,
}: {
  suggestions: string[];
  onAsk: (value: string) => void;
  disabled?: boolean;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Follow-up questions">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onAsk(suggestion)}
          className="rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function AssistantAnswer({
  response,
  text,
  onRegenerate,
  regenerateDisabled,
}: {
  response?: SearchQueryResponse;
  text: string;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      toast.success("Answer copied");
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Couldn't copy — select the text and copy it manually.");
    }
  };
  const link = response ? contextualLink(response) : null;
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-sage-soft text-accent-foreground">
          <Bot className="size-3.5" />
        </span>
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Housetory
        </span>
        <Badge variant="outline">
          {response?.scope_label ?? "All my places"}
        </Badge>
        {response && (
          <Badge
            variant={
              response.mode === "ai"
                ? "brass"
                : response.mode === "fallback"
                  ? "outline"
                  : "sage"
            }
          >
            {response.mode === "ai"
              ? "AI-assisted"
              : response.mode === "fallback"
                ? response.ai_status?.configured
                  ? "AI unavailable · used basic mode"
                  : "AI off · local answer"
                : "Direct lookup"}
          </Badge>
        )}
      </div>
      <AnswerText
        text={text}
        direction={response?.answer_direction ?? "auto"}
        preserveTerms={response?.preserve_terms ?? []}
        className="mt-3 text-sm leading-[1.8] text-foreground/85"
      />
      {response && response.notices.length > 0 && (
        <ul className="mt-3 space-y-1 text-2xs leading-relaxed text-muted-foreground">
          {response.notices.map((notice) => (
            <li key={notice}>• {notice}</li>
          ))}
        </ul>
      )}
      {response && response.borrowed.length > 0 && (
        <div className="mt-4 space-y-2" aria-label="Borrowed records">
          {response.borrowed.slice(0, 8).map((record) => {
            const place = borrowedPlaceLabel(record);
            return (
              <Link
                key={record.id}
                to={withHousehold(
                  `/borrowed/${record.id}`,
                  record.household_id,
                )}
                className="flex items-center gap-2 rounded-xl border border-brass/25 bg-brass-soft/20 px-3 py-2 text-xs transition-colors hover:bg-brass-soft/35"
              >
                <HandCoins className="size-3.5 shrink-0 text-brass" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate">{record.item_name}</span>
                    <Badge variant="brass" className="text-2xs">
                      Borrowed
                    </Badge>
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    Belongs to {record.owner_name} ·{" "}
                    {borrowedLocationPrefix(record)} {place} ·{" "}
                    {record.outstanding_quantity} outstanding
                    {record.due_on ? ` · due ${record.due_on}` : ""}
                  </span>
                </span>
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      )}
      {response && response.items.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {response.items.slice(0, 8).map((item) => {
            const container = itemContainer(item);
            const place =
              [
                item.property?.name,
                item.room?.name,
                container
                  ? locationLabel(container)
                  : item.location
                    ? locationLabel(item.location)
                    : null,
              ]
                .filter(Boolean)
                .join(" / ") || "No place recorded";
            return (
              <Link
                key={item.id}
                to={withHousehold(`/items/${item.id}`, item.household?.id)}
                className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs transition-colors hover:bg-secondary/40"
              >
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.name}</span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {place}
                    {item.on_loan_quantity
                      ? ` · ${item.on_loan_quantity} on loan`
                      : ""}
                  </span>
                </span>
                <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </div>
      )}
      {response && response.documents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {response.documents.slice(0, 5).map((document) => (
            <Link
              key={document.id}
              to={withHousehold(
                String(document.url),
                document.household_id ? String(document.household_id) : null,
              )}
            >
              <Badge
                variant="secondary"
                className="gap-1 hover:bg-secondary/70"
              >
                <FileText className="size-3" />
                {document.title}
              </Badge>
            </Link>
          ))}
        </div>
      )}
      {response && response.references.length > 0 && (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Sources
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response.references.slice(0, 12).map((reference) => (
              <Link
                key={`${reference.type}-${reference.id}`}
                to={withHousehold(reference.url, reference.household_id)}
              >
                <Badge variant="outline" className="hover:bg-secondary">
                  {reference.title}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}
      {link && (
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <Link to={link}>Open matching records</Link>
          </Button>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1 border-t border-border/60 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          Copy answer
        </Button>
        {onRegenerate && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerateDisabled}
          >
            <RotateCcw />
            Regenerate
          </Button>
        )}
      </div>
    </div>
  );
}
