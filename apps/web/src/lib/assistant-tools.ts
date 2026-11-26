import type { AssistantMessage, AssistantActionProposal } from "@/lib/assistant-conversation";
import type { ManualCitation, ReviewRun } from "@/lib/types";
import { api } from "@/lib/api";

export interface AssistantToolRequest {
  request_id: string;
  query: string;
  household_id?: string;
  property_id?: string;
  parent_id?: string;
  local_date: string;
  page_context: { kind: string; id: string }[];
  capture_context?: { kind: "items" | "document" | "photo"; id: string }[];
  /** A manual proposal the user just applied: the request starts with the step after it. */
  applied_proposal_id?: string;
}

export function createToolRun(request: AssistantToolRequest, signal: AbortSignal) {
  return api.post<AssistantToolRun>("/assistant/runs", request, { signal });
}

/** Say something to a request that is still running. Finished steps are kept. */
export function steerToolRun(runId: string, message: string, requestId: string) {
  return api.post<AssistantToolRun>(`/assistant/runs/${runId}/steer`, {
    request_id: requestId, message,
  });
}

export function cancelToolRun(runId: string) {
  return api.post<AssistantToolRun>(`/assistant/runs/${runId}/cancel`, {});
}

// The words that stop a running request when they are the whole message. This is a
// control, like the Stop button: what a message means is otherwise left to the assistant.
const STOP_WORDS = new Set(["stop", "cancel", "avbryt", "stopp"]);

/** True when the whole message is a stop word, for example "Stop." or "cancel!". */
export function isStopRequest(text: string) {
  return STOP_WORDS.has(text.trim().toLowerCase().replace(/[.!\s]+$/, ""));
}

/**
 * A manual the assistant found. `url` is the page that shows the file itself,
 * `details_url` is the document page. Neither is a capture or extraction review.
 */
export interface AssistantManualLink {
  document_id: string;
  title: string;
  url: string;
  download_url: string;
  details_url?: string | null;
  state: "readable" | "ocr_pending" | "ocr_failed" | "no_text";
  pages?: number;
  pages_read?: number;
  /** How many pages could not be read. They have no text. */
  pages_failed?: number;
}

/** An online source a tool returned. It is shown as a link that leaves the application. */
export interface AssistantWebSource {
  title: string;
  url: string;
  publisher?: string | null;
}

/** Proposals about an item's manual. After Apply the conversation carries on by itself. */
export const MANUAL_PROPOSAL_KINDS = new Set(["confirm_manual_identity", "save_manual"]);
export const CONTINUE_REQUEST = "Continue.";

export interface AssistantToolOutput {
  summary: string;
  error?: string | null;
  references: { id: string; title: string; url: string; household_id?: string | null }[];
  proposal?: AssistantActionProposal | null;
  capture?: { kind: "items" | "document" | "photo"; id: string } | null;
  review?: ReviewRun | null;
  manuals?: AssistantManualLink[];
  web_sources?: AssistantWebSource[];
  /** Only in results stored by earlier versions. Citations now belong to the answer. */
  citations?: ManualCitation[];
}

export interface AssistantToolRun {
  id: string;
  parent_id: string | null;
  household_id: string;
  property_id: string | null;
  query: string;
  state: string;
  generation: number;
  message: string;
  answer?: string | null;
  /** "general" when the answer is general guidance that rests on no household record. */
  answer_kind?: string | null;
  steps: { call: { name: string; arguments: Record<string, unknown> }; result: AssistantToolOutput }[];
  /** What the user said while the request ran, oldest first. */
  steers?: { id: string; text: string }[];
  /** While the request runs: a few words on what is being done now. */
  progress?: string | null;
  /** The manual pages the answer rests on. Each was read by the assistant. */
  citations?: ManualCitation[];
  model_calls: number;
  max_model_calls: number;
  /** How often the request went on by itself after it ran out of time. */
  continued?: number;
  can_retry: boolean;
  worker_available: boolean | null;
}

/** The request is still being worked on. */
export function toolRunActive(run: AssistantToolRun) {
  return ["queued", "running"].includes(run.state);
}

/** The review a step started. Status reads refer to a review already shown above. */
export function startedReview(step: AssistantToolRun["steps"][number]) {
  return step.call.name === "start_inventory_review" ? step.result.review ?? null : null;
}

export function assistantAnswerText(text: string, references: AssistantToolOutput["references"] = []) {
  const internalField = /^(?:[-*]\s*)?`?(?:item_id|item_ids|loan_id|record_id|review_run_id|scope_id|household_id|batch_state|background_active|created_suggestion_count|existing_suggestion_count|item_count_scanned|remaining_item_count|include_ai)`?\s*[:=]/;
  let answer = text.replace(/```[\s\S]*?```/g, "")
    .replace(/\s*\((?:item_id|loan_id|record_id|id)\s*:[^)]*\)/g, "")
    .split("\n").filter((line) => !internalField.test(line.trim()) &&
      !/^(?:GET |POST |PATCH |DELETE )?\/(?:api\/v\d+|assistant|inventory-review)\//.test(line.trim())).join("\n");
  for (const reference of references) answer = answer.replaceAll(reference.id, reference.title);
  return answer
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "the linked record")
    .replace(/\/(?:api\/v\d+|assistant|inventory-review|items|loans|borrowed|documents)\/[^\s)`,;]+/g, "the linked record")
    .replace(/\b(?:item_id|item_ids|loan_id|record_id|review_run_id|scope_id|household_id)\b/g, "record")
    .replace(/\b(?:batch_state|background_active|created_suggestion_count|existing_suggestion_count|item_count_scanned|remaining_item_count|include_ai)\b/g, "review details")
    .replace(/\bawaiting_approval\b/g, "ready for review")
    .replace(/\bneeds_attention\b/g, "needs attention")
    .trim();
}

function proposalExplanation(kind: string, proposal?: AssistantActionProposal) {
  // A change the application applied itself: there is nothing left to review.
  if (proposal?.applied_directly) return "Done. This change was applied for you.";
  if (kind === "return_loan" || kind === "return_borrowed") return "Review this return, then Apply to record it.";
  if (kind === "lend" || kind === "borrow") return "Review the lending details, then Apply to record them.";
  if (kind === "move_items") return "Review the destination, then Apply to move these items.";
  if (kind === "confirm_manual_identity") return "Check these product details against the label, then Apply to confirm them.";
  if (kind === "save_manual") return "Check that this manual is for your exact model, then Apply to download and attach it.";
  return "Review the change below, then Apply to save it.";
}

/** The authoritative review card for one proposal in its current server state. */
export function actionMessage(proposal: AssistantActionProposal, originalRequest = ""): AssistantMessage {
  return {
    role: "assistant", text: proposalExplanation(proposal.kind, proposal),
    action: {
      proposal, originalRequest, requestId: proposal.id, pending: false,
      ...(proposal.state === "applied" ? { result: proposal.message ?? "Already applied." } :
        proposal.state === "undone" ? { result: proposal.message ?? "Undone." } :
        proposal.state === "cancelled" || proposal.state === "superseded"
          ? { result: `Proposal ${proposal.state}.` }
          : proposal.state !== "ready" ? { conflict: "This proposal is stale. Refresh it before applying." } : {}),
    },
  };
}

export function toolRunMessages(run: AssistantToolRun): AssistantMessage[] {
  const messages: AssistantMessage[] = [
    { role: "user", text: run.query, toolRunId: run.id },
    // What the user added while the request ran belongs to the same request.
    ...(run.steers ?? []).map((steer): AssistantMessage => (
      { role: "user", text: steer.text, toolRunId: run.id }
    )),
  ];
  const seen = new Set<string>();
  // Prepared work is shown by its own card; the answer to everything else leads it.
  const answer = run.steps.some((step) => step.result.proposal || startedReview(step) || step.result.capture)
    && ["completed", "awaiting_approval"].includes(run.state)
    ? assistantAnswerText(run.answer ?? "", run.steps.flatMap(({ result }) => result.references ?? []))
    : "";
  if (answer) messages.push({ role: "assistant", text: answer, toolRunId: run.id, toolAnswer: true });
  // A proposal is shown when the request has ended. While the assistant still works,
  // the status line says that one is prepared: a card that can be applied in the middle
  // of a request looked like the end of it.
  const active = toolRunActive(run);
  for (const { result } of run.steps) {
    if (result.proposal && !active && !seen.has(result.proposal.id)) {
      const proposal = result.proposal;
      seen.add(proposal.id);
      messages.push({ ...actionMessage(proposal, run.query), toolRunId: run.id });
    }
    if (result.capture && !seen.has(result.capture.id)) {
      const capture = result.capture;
      seen.add(capture.id);
      messages.push({
        role: "assistant", text: result.summary, toolRunId: run.id,
        capture: {
          id: capture.id, kind: capture.kind,
          ...(capture.kind === "items" ? { importId: capture.id } :
            capture.kind === "document" ? { documentId: capture.id } : { recognitionId: capture.id }),
        },
      });
    }
  }
  messages.push({ role: "assistant", text: run.message, toolRunId: run.id, toolRun: run });
  return messages;
}

export function mergeToolRun(
  messages: AssistantMessage[], run: AssistantToolRun, beforeRunId?: string,
): AssistantMessage[] {
  const previousRun = messages.find((message) => message.toolRun?.id === run.id)?.toolRun;
  if (previousRun && (previousRun.generation > run.generation ||
    (previousRun.generation === run.generation && (
      previousRun.model_calls > run.model_calls ||
      (!["queued", "running"].includes(previousRun.state) && ["queued", "running"].includes(run.state))
    )))) run = previousRun;
  const incoming = toolRunMessages(run).map((message) => {
    const previous = message.action
      ? messages.find((entry) => entry.action?.proposal.id === message.action?.proposal.id)?.action
      : undefined;
    // An applied or undone change is settled on the server: its card follows the
    // server, so Undo is offered, and an undo made elsewhere is shown.
    const settled = ["applied", "undone"].includes(message.action?.proposal.state ?? "");
    return previous && message.action ? {
      ...message, action: {
        ...previous,
        ...(previous.editing || previous.pending || previous.conflict || (previous.result && !settled)
          ? {} : { proposal: message.action.proposal, result: message.action.result, conflict: message.action.conflict }),
      },
    } : message;
  });
  const arriving = new Set(incoming.flatMap((message) => message.action ? [message.action.proposal.id] : []));
  messages = messages.filter((message) =>
    message.toolRunId || !message.action || !arriving.has(message.action.proposal.id));
  const index = messages.findIndex((message) => message.toolRunId === run.id);
  if (index < 0) {
    const before = beforeRunId ? messages.findIndex((message) => message.toolRunId === beforeRunId) : -1;
    return before < 0 ? [...messages, ...incoming] : [
      ...messages.slice(0, before), ...incoming, ...messages.slice(before),
    ];
  }
  return [
    ...messages.slice(0, index),
    ...incoming,
    ...messages.slice(index).filter((message) => message.toolRunId !== run.id),
  ];
}
