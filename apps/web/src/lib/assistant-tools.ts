import type { AssistantMessage, AssistantActionProposal } from "@/lib/assistant-conversation";
import type { ReviewRun } from "@/lib/types";
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
}

export function createToolRun(request: AssistantToolRequest, signal: AbortSignal) {
  return api.post<AssistantToolRun>("/assistant/runs", request, { signal });
}

export interface AssistantToolOutput {
  summary: string;
  error?: string | null;
  references: { id: string; title: string; url: string; household_id?: string | null }[];
  proposal?: AssistantActionProposal | null;
  capture?: { kind: "items" | "document" | "photo"; id: string } | null;
  review?: ReviewRun | null;
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
  steps: { call: { name: string; arguments: Record<string, unknown> }; result: AssistantToolOutput }[];
  model_calls: number;
  max_model_calls: number;
  can_retry: boolean;
  worker_available: boolean | null;
}

export function toolRunMessages(run: AssistantToolRun): AssistantMessage[] {
  const messages: AssistantMessage[] = [
    { role: "user", text: run.query, toolRunId: run.id },
  ];
  const seen = new Set<string>();
  for (const { result } of run.steps) {
    if (result.proposal && !seen.has(result.proposal.id)) {
      const proposal = result.proposal;
      seen.add(proposal.id);
      messages.push({
        role: "assistant", text: result.summary, toolRunId: run.id,
        action: {
          proposal, originalRequest: run.query, requestId: proposal.id, pending: false,
          ...(proposal.state === "applied" ? { result: "Already applied." } :
            proposal.state === "cancelled" || proposal.state === "superseded"
              ? { result: `Proposal ${proposal.state}.` }
              : proposal.state !== "ready" ? { conflict: "This proposal is stale. Refresh it before applying." } : {}),
        },
      });
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
    return previous && message.action ? {
      ...message, action: {
        ...previous,
        ...(previous.editing || previous.pending || previous.result || previous.conflict
          ? {} : { proposal: message.action.proposal, result: message.action.result, conflict: message.action.conflict }),
      },
    } : message;
  });
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
