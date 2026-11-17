import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "@/components/account-menu";
import { ItemForm } from "@/components/item-form";
import { ITEM_DRAFT_SAVE_DELAY_MS } from "@/components/item-form-draft";
import { api } from "@/lib/api";
import {
  ITEM_DRAFT_MAX_AGE_MS,
  itemDraftFormId,
  itemDraftKey,
  type ItemDraftScope,
} from "@/lib/item-drafts";
import { NavigationGuardProvider } from "@/lib/navigation-guard";
import { queryKeys } from "@/lib/query-keys";
import { ItemEditPage, ItemNewPage } from "@/pages/item-form-pages";
import type { ItemDetail } from "@/lib/types";

const queryMocks = vi.hoisted(() => ({
  session: {
    authenticated: true,
    user: { id: "user-1", name: "Ada", email: "ada@example.com" },
    household: { id: "household-1", name: "Home", default_currency: "USD" },
    households: [],
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  };
});

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: queryMocks.session }),
    useLogout: () => ({
      isPending: false,
      mutate: (_input: undefined, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    }),
    useSelectHousehold: () => ({ isPending: false, mutate: vi.fn() }),
    useInvalidateInventory: () => vi.fn(),
    useDefaultCurrency: () => "USD",
    useProperties: () => ({ data: { items: [{ id: "property-1", name: "Home" }] } }),
    useRooms: () => ({
      data: {
        items: [
          { id: "room-1", name: "Workshop", property_id: "property-1" },
          { id: "room-2", name: "Kitchen", property_id: "property-1" },
        ],
      },
    }),
    useCategories: () => ({ data: { items: [] } }),
    useTags: () => ({ data: { items: [] } }),
    useDocuments: () => ({ data: { items: [] } }),
    useLocations: () => ({ data: { items: [] } }),
  };
});

const item = {
  id: "item-1",
  name: "Toolbox",
  description: null,
  brand: null,
  model: null,
  serial_number: null,
  quantity: 1,
  condition: "good",
  room: { id: "room-1", name: "Workshop" },
  property: { id: "property-1", name: "Home", is_archived: false },
  location: null,
  location_path: [],
  category: null,
  tags: [],
  purchase: null,
  purchase_info_status: "unrecorded",
  warranty: null,
  current_value_cents: null,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  photos: [],
  documents: [],
  storage: null,
} as unknown as ItemDetail;

const otherItem = { ...item, id: "item-2", name: "Drill" } as ItemDetail;

function scopeFor(formId: string): ItemDraftScope {
  return { userId: "user-1", householdId: "household-1", formId };
}

const newItemKey = itemDraftKey(scopeFor(itemDraftFormId({ context: {} })));
const editItemKey = itemDraftKey(scopeFor(itemDraftFormId({ itemId: "item-1" })));

function draftKeys() {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith("housetory:item-draft:"),
  );
}

function renderApp(path: string) {
  window.history.pushState(null, "", path);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <NavigationGuardProvider>
          <nav aria-label="Primary">
            <NavLink to="/rooms">Places</NavLink>
          </nav>
          <AccountMenu />
          <Routes>
            <Route path="/items" element={<Link to="/items/new">Add an item</Link>} />
            <Route path="/items/new" element={<ItemForm />} />
            <Route path="/rooms/:roomId/new" element={<ItemForm defaultRoomId="room-1" />} />
            <Route path="/kitchen/new" element={<ItemForm defaultRoomId="room-2" />} />
            <Route
              path="/items/item-1/edit"
              element={<ItemForm item={item} returnTo="/items/item-1" cancelTo="/items/item-1" />}
            />
            <Route path="/items/item-2/edit" element={<ItemForm item={otherItem} />} />
            <Route path="/items/:itemId" element={<p>Item detail page</p>} />
            <Route path="/rooms" element={<p>Places page</p>} />
            <Route path="/login" element={<p>Login page</p>} />
          </Routes>
        </NavigationGuardProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function hidePage() {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

async function typeName(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = screen.getByLabelText("Item name");
  await user.clear(input);
  await user.type(input, text);
}

function banner() {
  return screen.queryByRole("region", { name: "Unsaved draft found" });
}

beforeEach(() => {
  localStorage.clear();
  queryMocks.session.user.id = "user-1";
  queryMocks.session.household.id = "household-1";
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue({ item: { id: "item-9" } });
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.patch).mockResolvedValue({ item });
});

describe("ItemForm navigation confirm", () => {
  it("asks before a bottom-nav link leaves a dirty form and keeps the input on cancel", async () => {
    const user = userEvent.setup();
    renderApp("/items/new");
    await typeName(user, "Espresso machine");

    await user.click(screen.getByRole("link", { name: "Places" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item name")).toHaveValue("Espresso machine");
    expect(window.location.pathname).toBe("/items/new");
  });

  it("navigates and drops the draft when leaving is confirmed", async () => {
    const user = userEvent.setup();
    renderApp("/items/new");
    await typeName(user, "Espresso machine");
    hidePage();
    expect(localStorage.getItem(newItemKey)).not.toBeNull();

    await user.click(screen.getByRole("link", { name: "Places" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByText("Places page")).toBeVisible();
    expect(localStorage.getItem(newItemKey)).toBeNull();
  });

  it("asks on browser back from a dirty form and stays put on cancel", async () => {
    const user = userEvent.setup();
    renderApp("/items");
    await user.click(screen.getByRole("link", { name: "Add an item" }));
    await typeName(user, "Espresso machine");

    act(() => window.history.back());
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/items/new"));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Item name")).toHaveValue("Espresso machine");

    act(() => window.history.back());
    await screen.findByRole("dialog");
    await waitFor(() => expect(window.location.pathname).toBe("/items/new"));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("link", { name: "Add an item" })).toBeVisible();
    expect(window.location.pathname).toBe("/items");
  });

  it("leaves a clean form without a prompt, including after input is reverted", async () => {
    const user = userEvent.setup();
    renderApp("/items/item-1/edit");
    await typeName(user, "Toolbox");

    await user.click(screen.getByRole("link", { name: "Places" }));
    expect(screen.getByText("Places page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(draftKeys()).toEqual([]);
  });

  it("navigates after a successful save without a prompt and clears the draft", async () => {
    const user = userEvent.setup();
    renderApp("/items/new");
    await typeName(user, "Espresso machine");
    hidePage();
    expect(localStorage.getItem(newItemKey)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Add to your home" }));

    expect(await screen.findByText("Item detail page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(draftKeys()).toEqual([]);
  });

  it("treats Cancel as an explicit discard: no prompt and no draft left behind", async () => {
    const user = userEvent.setup();
    renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");
    hidePage();
    expect(localStorage.getItem(editItemKey)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Item detail page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(draftKeys()).toEqual([]);
  });
});

describe("ItemForm drafts", () => {
  it("saves the draft shortly after input without waiting for the page to hide", async () => {
    const user = userEvent.setup();
    renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");

    await waitFor(
      () => expect(localStorage.getItem(editItemKey)).toContain("Red toolbox"),
      { timeout: ITEM_DRAFT_SAVE_DELAY_MS * 4 },
    );
  });

  it("offers a draft for the same item and restores it only when asked", async () => {
    const user = userEvent.setup();
    const first = renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");
    first.unmount();

    renderApp("/items/item-1/edit");
    expect(banner()).toBeVisible();
    expect(banner()).toHaveTextContent(/Saved on this device/);
    expect(banner()).not.toHaveTextContent(/changed since/);
    expect(screen.getByLabelText("Item name")).toHaveValue("Toolbox");

    await user.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(screen.getByLabelText("Item name")).toHaveValue("Red toolbox");
    expect(banner()).not.toBeInTheDocument();
  });

  it("restores a new-item draft only for the same starting context", async () => {
    const user = userEvent.setup();
    const first = renderApp("/rooms/room-1/new");
    await typeName(user, "Workbench");
    await user.selectOptions(screen.getByLabelText("Condition"), "fair");
    first.unmount();

    const kitchen = renderApp("/kitchen/new");
    expect(banner()).not.toBeInTheDocument();
    kitchen.unmount();
    const blank = renderApp("/items/new");
    expect(banner()).not.toBeInTheDocument();
    blank.unmount();

    renderApp("/rooms/room-1/new");
    await user.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(screen.getByLabelText("Item name")).toHaveValue("Workbench");
    expect(screen.getByLabelText("Condition")).toHaveValue("fair");
    expect(screen.getByLabelText("Room")).toHaveValue("room-1");
  });

  it("does not offer a draft to a different account, household or item", async () => {
    const user = userEvent.setup();
    const first = renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");
    first.unmount();

    queryMocks.session.user.id = "user-2";
    const otherAccount = renderApp("/items/item-1/edit");
    expect(banner()).not.toBeInTheDocument();
    otherAccount.unmount();

    queryMocks.session.user.id = "user-1";
    queryMocks.session.household.id = "household-2";
    const otherHousehold = renderApp("/items/item-1/edit");
    expect(banner()).not.toBeInTheDocument();
    otherHousehold.unmount();

    queryMocks.session.household.id = "household-1";
    const differentItem = renderApp("/items/item-2/edit");
    expect(banner()).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item name")).toHaveValue("Drill");
    differentItem.unmount();

    renderApp("/items/item-1/edit");
    expect(banner()).toBeVisible();
  });

  it("says so when the item changed after the draft was saved", () => {
    const stored = {
      ...scopeFor(itemDraftFormId({ itemId: "item-1" })),
      savedAt: Date.now() - 60_000,
      itemUpdatedAt: "2026-01-01T00:00:00Z",
      values: draftValues("Red toolbox"),
    };
    localStorage.setItem(editItemKey, JSON.stringify(stored));

    renderApp("/items/item-1/edit");
    expect(banner()).toHaveTextContent(/This item has changed since the draft was saved/);
  });

  it("does not offer, and removes, a draft older than the expiry", () => {
    const stored = {
      ...scopeFor(itemDraftFormId({ itemId: "item-1" })),
      savedAt: Date.now() - ITEM_DRAFT_MAX_AGE_MS - 60_000,
      itemUpdatedAt: item.updated_at,
      values: draftValues("Red toolbox"),
    };
    localStorage.setItem(editItemKey, JSON.stringify(stored));

    renderApp("/items/item-1/edit");
    expect(banner()).not.toBeInTheDocument();
    expect(draftKeys()).toEqual([]);
  });

  it("clears the draft when it is discarded and keeps an undecided draft untouched", async () => {
    const user = userEvent.setup();
    const first = renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");
    first.unmount();

    const second = renderApp("/items/item-1/edit");
    await typeName(user, "Blue toolbox");
    hidePage();
    expect(localStorage.getItem(editItemKey)).toContain("Red toolbox");
    second.unmount();
    expect(localStorage.getItem(editItemKey)).toContain("Red toolbox");

    renderApp("/items/item-1/edit");
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(banner()).not.toBeInTheDocument();
    expect(draftKeys()).toEqual([]);
    expect(screen.getByLabelText("Item name")).toHaveValue("Toolbox");
  });

  it("clears every draft on sign-out, even with a dirty form still open", async () => {
    const user = userEvent.setup();
    const first = renderApp("/items/item-1/edit");
    await typeName(user, "Red toolbox");
    first.unmount();

    const open = renderApp("/items/new");
    await typeName(user, "Espresso machine");
    hidePage();
    expect(draftKeys()).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByText("Login page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    open.unmount();
    expect(draftKeys()).toEqual([]);
  });
});

function draftValues(name: string) {
  return {
    name,
    description: "",
    brand: "",
    model: "",
    serialNumber: "",
    quantity: "1",
    condition: "good",
    propertyId: "property-1",
    roomId: "room-1",
    locationId: "",
    categoryId: "",
    tagIds: [],
    vendor: "",
    purchaseDate: "",
    totalPrice: "",
    editedUnitPrice: null,
    currency: "USD",
    currencyTouched: false,
    priceBasis: "total",
    orderNumber: "",
    purchaseNotes: "",
    receiptDocumentId: "",
    purchaseInfoStatus: "auto",
    warrantyProvider: "",
    warrantyStart: "",
    warrantyDuration: "",
    warrantyEnd: "",
    warrantyReminder: "",
    warrantyDocumentId: "",
    warrantyNotes: "",
  };
}

describe("ItemForm identity changes on the real routes", () => {
  const drillKey = itemDraftKey(scopeFor(itemDraftFormId({ itemId: "item-2" })));

  function tree(client: QueryClient) {
    return (
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <NavigationGuardProvider>
            <nav aria-label="Primary">
              <NavLink to="/rooms">Places</NavLink>
              <Link to="/items/item-2/edit">Edit drill</Link>
              <Link to="/items/new?room_id=room-2">Add to kitchen</Link>
            </nav>
            <Routes>
              <Route path="/items/new" element={<ItemNewPage />} />
              <Route path="/items/:itemId/edit" element={<ItemEditPage />} />
              <Route path="/items/:itemId" element={<p>Item detail page</p>} />
              <Route path="/rooms" element={<p>Places page</p>} />
            </Routes>
          </NavigationGuardProvider>
        </BrowserRouter>
      </QueryClientProvider>
    );
  }

  // Both items are already cached, so moving between their edit pages never unmounts the page.
  function renderRoutes(path: string) {
    window.history.pushState(null, "", path);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(queryKeys.item("item-1"), { item });
    client.setQueryData(queryKeys.item("item-2"), { item: otherItem });
    const view = render(tree(client));
    return { client, rerender: () => view.rerender(tree(client)) };
  }

  const nameInput = () => screen.getByLabelText<HTMLInputElement>("Item name");
  const discardDialog = () => screen.queryByRole("dialog", { name: "Discard unsaved changes?" });

  it("opens the other item with its own values, draft key, dirty baseline and guard", async () => {
    const user = userEvent.setup();
    renderRoutes("/items/item-1/edit");
    await typeName(user, "Toolbox renamed");

    await user.click(screen.getByRole("link", { name: "Edit drill" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(nameInput()).toHaveValue("Drill"));
    expect(screen.getByRole("heading", { name: "Drill" })).toBeVisible();
    expect(draftKeys()).toEqual([]);

    expect(discardDialog()).toBeNull();
    // Its edits are drafted under its own key and guarded again.
    await typeName(user, "Drill v2");
    hidePage();
    expect(draftKeys()).toEqual([drillKey]);
    expect(JSON.parse(localStorage.getItem(drillKey) ?? "{}").values.name).toBe("Drill v2");
    await user.click(screen.getByRole("link", { name: "Places" }));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(nameInput()).toHaveValue("Drill v2");

    vi.mocked(api.patch).mockResolvedValue({ item: { ...otherItem, name: "Drill v2" } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, payload] = vi.mocked(api.patch).mock.calls[0]!;
    expect(path).toBe("/items/item-2");
    expect(payload).toMatchObject({ name: "Drill v2" });
    expect(JSON.stringify(payload)).not.toContain("Toolbox");
    await waitFor(() => expect(draftKeys()).toEqual([]));
  });

  it("keeps edits in progress when the same item is refreshed in the background", async () => {
    const user = userEvent.setup();
    const { client } = renderRoutes("/items/item-1/edit");
    await typeName(user, "Toolbox renamed");
    act(() => {
      client.setQueryData(queryKeys.item("item-1"), {
        item: { ...item, description: "Refreshed elsewhere", updated_at: "2026-03-01T00:00:00Z" },
      });
    });
    expect(nameInput()).toHaveValue("Toolbox renamed");
    hidePage();
    expect(draftKeys()).toEqual([editItemKey]);
  });

  it("starts a new-item form afresh when its starting context changes", async () => {
    const user = userEvent.setup();
    renderRoutes("/items/new?room_id=room-1");
    await typeName(user, "Lamp");

    await user.click(screen.getByRole("link", { name: "Add to kitchen" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(nameInput()).toHaveValue(""));
    expect(draftKeys()).toEqual([]);
    await typeName(user, "Kettle");
    hidePage();
    expect(draftKeys()).toEqual([
      itemDraftKey(scopeFor(itemDraftFormId({ context: { room_id: "room-2" } }))),
    ]);
    await user.click(screen.getByRole("button", { name: /save|add/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]).toEqual([
      "/items", expect.objectContaining({ name: "Kettle", room_id: "room-2" }),
    ]);
  });

  it("resets the form and its draft scope when the household or account changes", async () => {
    const user = userEvent.setup();
    const { rerender } = renderRoutes("/items/item-1/edit");
    await typeName(user, "Toolbox renamed");

    queryMocks.session.household.id = "household-2";
    rerender();
    await waitFor(() => expect(nameInput()).toHaveValue("Toolbox"));
    // The interrupted edit stays recoverable where it was made.
    expect(draftKeys()).toEqual([editItemKey]);

    await typeName(user, "Other home toolbox");
    hidePage();
    const otherHome = itemDraftKey({
      userId: "user-1", householdId: "household-2", formId: itemDraftFormId({ itemId: "item-1" }),
    });
    expect(draftKeys().sort()).toEqual([editItemKey, otherHome].sort());

    queryMocks.session.user.id = "user-2";
    rerender();
    await waitFor(() => expect(nameInput()).toHaveValue("Toolbox"));
    expect(banner()).toBeNull();
  });
});
