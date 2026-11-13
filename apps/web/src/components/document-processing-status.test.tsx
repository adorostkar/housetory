import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { DocumentProcessing } from "@/lib/types";

const state = vi.hoisted(() => ({ canWrite: true }));
vi.mock("@/lib/queries", async (original) => ({
  ...await original<typeof import("@/lib/queries")>(),
  useCanWrite: () => state.canWrite,
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const running: DocumentProcessing = {
  correlation_id: "attempt-1", stage: "interpreting",
  started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:15Z",
  elapsed_ms: 15000, local_available: true, can_cancel: true, can_retry: false,
  worker_available: true, reason: null,
  timings: { local_queue_ms: 1, local_processing_ms: 2, ai_queue_ms: 3, provider_ms: null, validation_ms: null },
};

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const manual = vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter>
    <DocumentProcessingStatus documentId="doc-1" onManualReview={manual} />
  </MemoryRouter></QueryClientProvider>);
  return { client, manual };
}

beforeEach(() => {
  state.canWrite = true;
  vi.mocked(api.get).mockReset().mockResolvedValue(running);
  vi.mocked(api.post).mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("DocumentProcessingStatus", () => {
  it("reports honest slow-stage and local review, without percentages", async () => {
    const { manual } = show();
    expect(await screen.findByText("Interpreting document")).toBeVisible();
    expect(screen.getByText("15s elapsed")).toBeVisible();
    expect(screen.getByText(/taking longer than usual/)).toBeVisible();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use local/manual review now" }));
    expect(manual).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancel processing" })).toBeVisible();
  });

  it("polls active work each second and stops after the server reaches ready", async () => {
    vi.useFakeTimers();
    show();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.get).toHaveBeenCalledTimes(1);
    vi.mocked(api.get).mockResolvedValue({ ...running, stage: "ready", can_cancel: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("Ready to review")).toBeVisible();
    const calls = vi.mocked(api.get).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.get).toHaveBeenCalledTimes(calls);
  });

  it("cancels the attempt, retains manual access and offers an explicit canonical retry", async () => {
    const cancelled = { ...running, stage: "cancelled", can_cancel: false, can_retry: true } satisfies DocumentProcessing;
    vi.mocked(api.post).mockResolvedValueOnce(cancelled).mockResolvedValueOnce({
      ...running, correlation_id: "attempt-2", stage: "waiting", elapsed_ms: 0,
    });

    show();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByText("Processing cancelled")).toBeVisible();
    expect(api.post).toHaveBeenCalledWith("/documents/doc-1/processing/cancel");
    expect(screen.getByRole("button", { name: "Use local/manual review now" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
    expect(await screen.findByText("Waiting for processing")).toBeVisible();
    expect(api.post).toHaveBeenCalledWith("/documents/doc-1/processing/retry");
  });

  it("fences an in-flight status response when cancellation succeeds", async () => {
    const { client } = show();
    await screen.findByText("Interpreting document");
    let finish!: (value: DocumentProcessing) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(api.get).mockImplementation((_path, options) => {
      signal = options?.signal ?? undefined;
      return new Promise((resolve) => { finish = resolve; });
    });
    const refresh = client.refetchQueries({ queryKey: [...queryKeys.document("doc-1"), "processing"] });
    await act(async () => { await Promise.resolve(); });
    vi.mocked(api.post).mockResolvedValue({
      ...running, stage: "cancelled", can_cancel: false, can_retry: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByText("Processing cancelled")).toBeVisible();
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ ...running, stage: "ready" }); await refresh; });
    expect(screen.queryByText("Ready to review")).not.toBeInTheDocument();
    expect(screen.getByText("Processing cancelled")).toBeVisible();
  });

  it("shows a missing worker instead of an indefinite working spinner", async () => {
    vi.mocked(api.get).mockResolvedValue({ ...running, stage: "waiting", worker_available: false, elapsed_ms: 60000 });
    show();
    expect(await screen.findByText("Processing worker unavailable")).toBeVisible();
    expect(screen.getByText(/No healthy worker/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Enter items manually" })).toHaveAttribute("href", "/items/new");
  });

  it("keeps a failed cancel actionable and never reports it as cancelled", async () => {
    vi.mocked(api.post).mockRejectedValue(new Error("Cancellation unavailable"));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation unavailable");
    expect(screen.queryByText("Processing cancelled")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel processing" })).toBeEnabled();
  });

  it("has an explicit manual fallback when status cannot be fetched", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("Offline"));
    show();
    expect(await screen.findByText(/Processing status is unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Enter items manually" })).toBeVisible();
  });

  it("does not offer mutation controls to viewers", async () => {
    state.canWrite = false;
    show();
    await waitFor(() => expect(screen.getByText("Interpreting document")).toBeVisible());
    expect(screen.queryByRole("button", { name: "Cancel processing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry processing" })).not.toBeInTheDocument();
  });
});
