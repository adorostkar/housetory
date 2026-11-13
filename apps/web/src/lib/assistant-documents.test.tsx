import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";

import {
  AssistantDocumentSlot,
  AssistantDocumentsProvider,
  useAssistantDocuments,
} from "@/lib/assistant-documents";
const mockState = vi.hoisted(() => ({ householdId: "house-1", render: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  useSession: () => ({ data: { household: { id: mockState.householdId } } }),
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
});

it("pauses inactive document review without losing edits and clears it on a household change", async () => {
  const rendered = render(<AssistantDocumentsProvider><Fixture /></AssistantDocumentsProvider>);
  fireEvent.click(screen.getByText("Select document"));
  expect(await screen.findByText("document-1: active")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Review draft"), { target: { value: "Edited draft" } });
  fireEvent.click(screen.getByText("Toggle slot"));
  expect(mockState.render).toHaveBeenLastCalledWith("document-1", false);
  fireEvent.click(screen.getByText("Toggle slot"));
  expect(await screen.findByText("document-1: active")).toBeVisible();
  expect(screen.getByLabelText("Review draft")).toHaveValue("Edited draft");
  mockState.householdId = "house-2";
  rendered.rerender(<AssistantDocumentsProvider><Fixture /></AssistantDocumentsProvider>);
  expect(screen.queryByLabelText("Review draft")).toBeNull();
});
