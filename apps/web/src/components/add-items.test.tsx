import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  AddItemsButton,
  AddItemsProvider,
  useRegisterAddItemsContext,
} from "@/components/add-items";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useCanWrite: () => true };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function RegisteredContext() {
  useRegisterAddItemsContext({
    roomId: "room-9",
    locationId: "box-9",
    roomName: "Office",
    locationName: "BOX-009",
  });
  return null;
}

function renderChooser({
  context,
  register = false,
}: {
  context?: {
    roomId?: string;
    locationId?: string;
    roomName?: string;
    locationName?: string;
  };
  register?: boolean;
} = {}) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AddItemsProvider>
        {register ? <RegisteredContext /> : null}
        <AddItemsButton context={context} />
        <LocationProbe />
      </AddItemsProvider>
    </MemoryRouter>,
  );
}

describe("AddItems", () => {
  it.each([
    ["Enter manually", "/items/new"],
    ["Scan a photo", "/scan"],
    ["Import a list or file", "/imports"],
  ])("opens %s with the preserved room and place context", async (choice, path) => {
    renderChooser({
      context: {
        roomId: "room-1",
        locationId: "box-1",
        roomName: "Office",
        locationName: "BOX-001",
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Add items" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Office · BOX-001")).toBeVisible();
    expect(screen.getByRole("button", { name: /Enter manually/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(choice) }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `${path}?room_id=room-1&location_id=box-1`,
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("activates the focused choice with Enter", async () => {
    renderChooser();
    await userEvent.click(screen.getByRole("button", { name: "Add items" }));
    expect(
      screen.getByRole("button", { name: /Enter manually/ }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/items/new"),
    );
  });

  it("uses page-registered context for the global Add items button", async () => {
    renderChooser({ register: true });
    await userEvent.click(screen.getByRole("button", { name: "Add items" }));
    await userEvent.click(screen.getByRole("button", { name: /Scan a photo/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/scan?room_id=room-9&location_id=box-9",
      ),
    );
  });

  it("closes with Escape and restores focus to the trigger", async () => {
    renderChooser();
    const trigger = screen.getByRole("button", { name: "Add items" });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
