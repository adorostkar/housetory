import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemDispositionDialog } from "@/components/item-disposition-dialog";
import { api } from "@/lib/api";
import type { ItemDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, patch: vi.fn() } };
});

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useInvalidateInventory: () => vi.fn() };
});

const item = { id: "item-1", name: "Camera" } as ItemDetail;

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ItemDispositionDialog open onOpenChange={onOpenChange} item={item} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

beforeEach(() => {
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.patch).mockResolvedValue({ item });
});

describe("ItemDispositionDialog", () => {
  it("records an outcome, date and note without deleting the item", async () => {
    const onOpenChange = renderDialog();
    await userEvent.selectOptions(screen.getByLabelText("What happened?"), "given_away");
    await userEvent.type(
      screen.getByLabelText(/^Note/),
      "Given to Alex for the camping trip.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Mark as no longer owned" }),
    );

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith("/items/item-1", {
      is_archived: true,
      disposition: "given_away",
      disposed_on: new Date().toISOString().slice(0, 10),
      disposition_note: "Given to Alex for the camping trip.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires an outcome before submitting", async () => {
    renderDialog();
    expect(
      screen.getByRole("button", { name: "Mark as no longer owned" }),
    ).toBeDisabled();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
