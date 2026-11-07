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
    ["Record a voice note", "/voice"],
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
    await waitFor(() => {
      const url = new URL(
        screen.getByTestId("location").textContent ?? "/",
        "http://housetory.invalid",
      );
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("room_id")).toBe("room-1");
      expect(url.searchParams.get("location_id")).toBe("box-1");
      expect(url.searchParams.get("from")).toBe("/");
      expect(url.searchParams.get("from_label")).toBe("Office · BOX-001");
    });
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
    await waitFor(() => {
      const url = new URL(
        screen.getByTestId("location").textContent ?? "/",
        "http://housetory.invalid",
      );
      expect(url.pathname).toBe("/scan");
      expect(url.searchParams.get("room_id")).toBe("room-9");
      expect(url.searchParams.get("location_id")).toBe("box-9");
      expect(url.searchParams.get("from")).toBe("/");
      expect(url.searchParams.get("from_label")).toBe("Office · BOX-009");
    });
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
