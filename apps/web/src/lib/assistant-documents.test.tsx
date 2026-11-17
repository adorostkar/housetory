import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, expect, it, vi, type Mock } from "vitest";

import {
  AssistantDocumentSlot,
  AssistantDocumentsProvider,
  useAssistantDocuments,
} from "@/lib/assistant-documents";
import { ASSISTANT_TASK_COMPLETED_EVENT, type CaptureReview } from "@/lib/assistant-task-events";
const mockState: {
  householdId: string;
  render: Mock<(id: string, enabled: boolean) => void>;
  reviews: CaptureReview[];
  updatedAt: number;
  fetching: boolean;
  dismissedListRequested: boolean;
} = vi.hoisted(() => ({ householdId: "house-1", render: vi.fn<(id: string, enabled: boolean) => void>(), reviews: [], updatedAt: 0, fetching: false, dismissedListRequested: false }));
vi.mock("@/lib/queries", () => ({
  useSession: () => ({ data: { household: { id: mockState.householdId } } }),
  useCaptureReviews: (dismissed = false) => ({
    data: dismissed ? (mockState.dismissedListRequested = true, []) : mockState.reviews, isError: false,
    dataUpdatedAt: mockState.updatedAt, isFetching: mockState.fetching,
  }),
}));
vi.mock("@/components/assistant-document-review", () => ({
  AssistantDocumentReview: ({ id, enabled }: { id: string; enabled: boolean }) => {
    mockState.render(id, enabled);
    return (
      <div>
        <span>{id}: {enabled ? "active" : "paused"}</span>
        <input aria-label="Review draft" defaultValue="Original draft" />
      </div>
    );
  },
}));

function Fixture() {
  const { select } = useAssistantDocuments();
  const [visible, setVisible] = React.useState(true);
  return (
    <>
      <button onClick={() => select("document-1")}>Select document</button>
      <button onClick={() => setVisible((value) => !value)}>Toggle slot</button>
      {visible && <AssistantDocumentSlot />}
    </>
  );
}

beforeEach(() => {
  mockState.householdId = "house-1";
  mockState.render.mockClear();
  mockState.reviews = [];
  mockState.updatedAt = Date.now();
  mockState.fetching = false;
});

it("restores silently and emits only active completion transitions, including a new retry attempt", () => {
  const client = new QueryClient();
  const event = vi.fn();
  window.addEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
  const ready: CaptureReview = { id: "document-1", kind: "document", title: "Invoice", status: "ready", generation: "first" };
  mockState.reviews = [ready];
  const tree = () => <QueryClientProvider client={client}><AssistantDocumentsProvider>{null}</AssistantDocumentsProvider></QueryClientProvider>;
  const rendered = render(tree());
  expect(event).not.toHaveBeenCalled();
  mockState.reviews = [ready, { ...ready, id: "document-2", status: "reading" }];
  rendered.rerender(tree());
  mockState.reviews = [ready, { ...ready, id: "document-2", status: "failed" }];
  rendered.rerender(tree());
  expect(event).toHaveBeenCalledTimes(1);
  rendered.rerender(tree());
  expect(event).toHaveBeenCalledTimes(1);
  // Resuming seeds a fresh baseline even when previously-running work finished.
  act(() => window.dispatchEvent(new Event("focus")));
  mockState.updatedAt = Date.now() + 1;
  mockState.reviews = [ready, { ...ready, id: "document-2", status: "ready" }];
  rendered.rerender(tree());
  expect(event).toHaveBeenCalledTimes(1);
  mockState.reviews = [{ ...ready, generation: "retry", status: "reading" }];
  rendered.rerender(tree());
  mockState.reviews = [{ ...ready, generation: "retry", status: "ready" }];
  rendered.rerender(tree());
  expect(event).toHaveBeenCalledTimes(2);
  window.removeEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
});

it("keeps a dismissed attempt silent after Undo and on provider remount", () => {
  const client = new QueryClient();
  const event = vi.fn();
  window.addEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
  const review: CaptureReview = { id: "document-1", kind: "document", title: "Invoice", status: "reading", generation: "first" };
  mockState.reviews = [review];
  const tree = () => <QueryClientProvider client={client}><AssistantDocumentsProvider>{null}</AssistantDocumentsProvider></QueryClientProvider>;
  const rendered = render(tree());
  mockState.reviews = [];
  rendered.rerender(tree());
  mockState.reviews = [{ ...review, status: "ready", notify: false }];
  rendered.rerender(tree());
  expect(event).not.toHaveBeenCalled();
  rendered.unmount();
  mockState.reviews = [{ ...review, status: "ready" }];
  render(tree());
  expect(event).not.toHaveBeenCalled();
  window.removeEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
});

it("can notify a capture created here during initial loading without replaying existing reviews", () => {
  const client = new QueryClient();
  const event = vi.fn();
  window.addEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
  function CreateCapture() {
    const { select } = useAssistantDocuments();
    return <button onClick={() => select("document-new", true)}>Created here</button>;
  }
  mockState.fetching = true;
  const tree = () => <QueryClientProvider client={client}><AssistantDocumentsProvider><CreateCapture /></AssistantDocumentsProvider></QueryClientProvider>;
  const rendered = render(tree());
  fireEvent.click(screen.getByText("Created here"));
  mockState.fetching = false;
  mockState.reviews = [
    { id: "document-old", kind: "document", title: "Existing", generation: "old", status: "ready" },
    { id: "document-new", kind: "document", title: "Created", generation: "new", status: "ready" },
  ];
  rendered.rerender(tree());
  expect(event).toHaveBeenCalledTimes(1);
  const notification = event.mock.calls[0]?.[0];
  expect(notification).toBeInstanceOf(CustomEvent);
  expect(notification?.detail.id).toBe("document-new");
  window.removeEventListener(ASSISTANT_TASK_COMPLETED_EVENT, event);
});

it("keeps document review mounted without losing edits and clears it on a household change", async () => {
  const client = new QueryClient();
  const tree = () => <QueryClientProvider client={client}><AssistantDocumentsProvider><Fixture /></AssistantDocumentsProvider></QueryClientProvider>;
  const rendered = render(tree());
  fireEvent.click(screen.getByText("Select document"));
  expect(await screen.findByText("document-1: active")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Review draft"), { target: { value: "Edited draft" } });
  fireEvent.click(screen.getByText("Toggle slot"));
  expect(mockState.render).toHaveBeenLastCalledWith("document-1", true);
  fireEvent.click(screen.getByText("Toggle slot"));
  expect(await screen.findByText("document-1: active")).toBeVisible();
  expect(screen.getByLabelText("Review draft")).toHaveValue("Edited draft");
  mockState.householdId = "house-2";
  rendered.rerender(tree());
  expect(screen.queryByLabelText("Review draft")).toBeNull();
});

it("does not load the dismissed list app-wide", () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <AssistantDocumentsProvider><Fixture /></AssistantDocumentsProvider>
    </QueryClientProvider>,
  );
  expect(mockState.dismissedListRequested).toBe(false);
});
