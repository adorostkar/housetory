import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AddItemsButton,
  AddItemsProvider,
  AddItemsRedirect,
  useRegisterAddItemsContext,
} from "@/components/add-items";
import { api } from "@/lib/api";

const state = vi.hoisted(() => ({
  recognition: null as any,
  voiceNote: null as any,
  transcription: { configured: true, available: true } as any,
  properties: [{ id: "home", name: "Home" }] as any[],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, post: vi.fn(), postForm: vi.fn() } };
});
vi.mock("@/hooks/use-voice-recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-voice-recorder")>();
  return {
    ...actual,
    useVoiceRecorder: ({
      onRecorded,
    }: {
      onRecorded: (file: File, duration: number) => void;
    }) => ({
      recording: false,
      elapsed: 0,
      error: null,
      start: async () =>
        onRecorded(new File(["audio"], "voice-note.webm", { type: "audio/webm" }), 4),
      stop: vi.fn(),
      cancel: vi.fn(),
    }),
  };
});
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useProperties: () => ({ data: { items: state.properties } }),
    useRooms: () => ({
      data: {
        items: [
          { id: "room-1", name: "Office", property_id: "home" },
          { id: "room-2", name: "Garage", property_id: "home" },
        ],
      },
    }),
    useLocations: () => ({
      data: {
        items: [
          { id: "box-1", room_id: "room-1", name: "Cables", identifier: "BOX-001" },
          { id: "shelf-1", room_id: "room-2", name: "Shelf", identifier: null },
        ],
      },
    }),
    useRecognition: () => ({ data: state.recognition }),
    useVoiceNote: () => ({ data: state.voiceNote }),
    useVoiceConfig: () => ({ data: { max_duration_seconds: 120 } }),
    useAiStatus: () => ({ data: state.transcription }),
  };
});

function LocationProbe() {
  const location = useLocation();
  return <>
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
    <output data-testid="navigation-state">{JSON.stringify(location.state)}</output>
  </>;
}

function RegisteredContext() {
  useRegisterAddItemsContext({
    roomId: "room-1",
    locationId: "box-1",
    roomName: "Office",
    locationName: "BOX-009",
  });
  return null;
}

const officeBox = {
  roomId: "room-1",
  locationId: "box-1",
  roomName: "Office",
  locationName: "BOX-001",
};

function renderAddItems({
  context,
  register = false,
  initialEntry = "/",
}: {
  context?: typeof officeBox;
  register?: boolean;
  initialEntry?: string;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AddItemsProvider>
          {register ? <RegisteredContext /> : null}
          <AddItemsButton context={context} />
          <Routes>
            <Route path="/add-items" element={<AddItemsRedirect />} />
            <Route path="*" element={null} />
          </Routes>
          <LocationProbe />
        </AddItemsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, refresh: () => view.rerender(ui()) };
}

async function open(context?: typeof officeBox) {
  const view = renderAddItems({ context });
  await userEvent.click(screen.getByRole("button", { name: "Add items" }));
  expect(screen.getByRole("dialog", { name: "Add items" })).toBeVisible();
  return view;
}

const textbox = () =>
  screen.getByRole("textbox", { name: "Describe items or paste a product link" });
const review = () => screen.getByRole("button", { name: "Review items" });
const mic = () => screen.getByRole("button", { name: "Record voice note" });
const currentUrl = () =>
  new URL(screen.getByTestId("location").textContent ?? "/", "http://housetory.invalid");

function attachPhoto(name = "backpack.png") {
  fireEvent.change(screen.getByTestId("smart-add-library"), {
    target: { files: [new File(["image"], name, { type: "image/png" })] },
  });
}

beforeEach(() => {
  state.recognition = null;
  state.voiceNote = null;
  state.transcription = { configured: true, available: true };
  state.properties = [{ id: "home", name: "Home" }];
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockImplementation(async (path) => {
    if (path === "/ai/recognitions") return { id: "recognition-1" };
    if (path === "/voice") return { id: "note-1", status: "queued" };
    return { id: "batch-1", entries: [] };
  });
  vi.mocked(api.post).mockResolvedValue({ id: "batch-1", entries: [] });
});

describe("AddItems smart input", () => {
  it("uploads a PDF directly as a document, retaining the note without image recognition", async () => {
    vi.mocked(api.postForm).mockResolvedValue({ id: "invoice-1" });
    await open(officeBox);
    await userEvent.type(textbox(), "Invoice for the office");
    const file = new File(["%PDF-1.4"], "invoice.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("smart-add-library"), { target: { files: [file] } });
    expect(screen.getByText("invoice.pdf")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review document" }));
    await waitFor(() => expect(currentUrl().pathname).toBe("/documents/invoice-1"));
    expect(api.postForm).toHaveBeenCalledTimes(1);
    const [path, form] = vi.mocked(api.postForm).mock.calls[0]!;
    expect(path).toBe("/documents");
    expect(form.get("file")).toBe(file);
    expect(form.get("notes")).toBe("Invoice for the office");
    expect(form.get("document_type")).toBe("invoice");
    expect(form.get("room_id")).toBeNull();
    expect(form.get("location_id")).toBeNull();
    expect(screen.getByTestId("navigation-state")).toHaveTextContent(
      JSON.stringify({ documentCapture: { documentId: "invoice-1", roomId: "room-1", locationId: "box-1" } }),
    );
  });

  it("lets a receipt image bypass recognition through an explicit evidence intent", async () => {
    vi.mocked(api.postForm).mockResolvedValue({ id: "receipt-1" });
    await open();
    attachPhoto("receipt.png");
    await userEvent.click(screen.getByRole("radio", { name: "Invoice or evidence" }));
    await userEvent.click(screen.getByRole("button", { name: "Review document" }));
    await waitFor(() => expect(currentUrl().pathname).toBe("/documents/receipt-1"));
    expect(api.postForm).toHaveBeenCalledExactlyOnceWith("/documents", expect.any(FormData));
  });

  it("accepts a PDF dropped without browser MIME metadata and supplies its upload MIME", async () => {
    vi.mocked(api.postForm).mockResolvedValue({ id: "pdf-1" });
    await open();
    const file = new File(["%PDF"], "invoice.PDF");
    fireEvent.drop(textbox().parentElement!, { dataTransfer: { files: [file] } });
    await userEvent.click(screen.getByRole("button", { name: "Review document" }));
    await waitFor(() => expect(api.postForm).toHaveBeenCalled());
    const uploaded = vi.mocked(api.postForm).mock.calls[0]![1].get("file") as File;
    expect(uploaded.type).toBe("application/pdf");
    expect(uploaded.name).toBe("invoice.PDF");
    expect(uploaded.size).toBe(file.size);
  });

  it("rejects unsupported attachments before upload without discarding the draft or valid file", async () => {
    await open();
    await userEvent.type(textbox(), "Keep my note");
    attachPhoto();
    fireEvent.change(screen.getByTestId("smart-add-library"), {
      target: { files: [new File(["zip"], "archive.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF");
    expect(textbox()).toHaveValue("Keep my note");
    expect(screen.getByText("backpack.png")).toBeVisible();
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("shows actual upload state and retains a failed document attachment for retry", async () => {
    let rejectUpload!: (error: Error) => void;
    vi.mocked(api.postForm).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectUpload = reject;
    }));
    await open();
    const file = new File(["%PDF"], "invoice.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("smart-add-library"), { target: { files: [file] } });
    await userEvent.click(screen.getByRole("button", { name: "Review document" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Uploading original document");
    await act(async () => rejectUpload(new Error("Upload unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload unavailable");
    expect(screen.getByText("invoice.pdf")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review document" })).toBeEnabled();
  });

  it("waits for a tap to focus the mobile box and live-detects text, link and photo input", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Add items" })).toHaveFocus();
    expect(textbox()).not.toHaveFocus();
    expect(review()).toBeDisabled();

    await userEvent.click(textbox());
    expect(textbox()).toHaveFocus();
    await userEvent.type(textbox(), "Two camping chairs");
    expect(screen.getByText("Text")).toBeVisible();
    expect(review()).toBeEnabled();

    await userEvent.clear(textbox());
    await userEvent.type(textbox(), "https://shop.example/osprey");
    expect(screen.getByText("Link")).toBeVisible();

    await userEvent.clear(textbox());
    attachPhoto();
    expect(screen.getByText("Photo")).toBeVisible();
    await userEvent.type(textbox(), "Blue backpack");
    expect(screen.getByText("Photo + note")).toBeVisible();
  });

  it("submits text with Ctrl+Enter, keeps Enter as a newline and navigates to the review", async () => {
    await open(officeBox);
    await userEvent.type(textbox(), "Two chairs{Enter}One table");
    expect(textbox()).toHaveValue("Two chairs\nOne table");
    expect(api.postForm).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith("/imports", expect.any(FormData)),
    );
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("text")).toBe("Two chairs\nOne table");
    expect(form.get("product_url")).toBeNull();
    expect(form.get("purchase_date")).toBeNull();
    expect(form.get("room_id")).toBe("room-1");
    expect(form.get("location_id")).toBe("box-1");
    expect(form.get("property_id")).toBe("home");
    await waitFor(() => expect(currentUrl().pathname).toBe("/imports/batch-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("imports a single product link", async () => {
    await open();
    await userEvent.type(textbox(), "  https://shop.example/osprey-jet-18 ");
    await userEvent.click(review());
    await waitFor(() => expect(api.postForm).toHaveBeenCalled());
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("product_url")).toBe("https://shop.example/osprey-jet-18");
    expect(form.get("text")).toBeNull();
  });

  it("reviews a photo and its note together through recognition", async () => {
    const view = await open();
    await userEvent.type(textbox(), "Blue backpack on the left");
    attachPhoto();
    await userEvent.click(review());
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith("/ai/recognitions", expect.any(FormData)),
    );
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("text")).toBe("Blue backpack on the left");
    expect(form.get("file")).toBeInstanceOf(File);
    await act(async () => {
      await Promise.resolve();
    });

    state.recognition = { id: "recognition-1", status: "succeeded" };
    view.refresh();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/imports/from-recognition/recognition-1"),
    );
    await waitFor(() => expect(currentUrl().pathname).toBe("/imports/batch-1"));
  });

  it("stores a photographed receipt as a document and opens its review", async () => {
    vi.mocked(api.postForm).mockImplementation(async (path) => {
      if (path === "/ai/recognitions") return { id: "recognition-1" };
      if (path === "/documents") return { id: "doc-9" };
      return { id: "batch-1", entries: [] };
    });
    const view = await open();
    attachPhoto("receipt.png");
    await userEvent.click(review());
    await waitFor(() => expect(api.postForm).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    state.recognition = {
      id: "recognition-1",
      status: "succeeded",
      result: { is_document: true, document_type: "receipt", suggestions: [] },
    };
    view.refresh();
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith("/documents", expect.any(FormData)),
    );
    const form = vi.mocked(api.postForm).mock.calls.at(-1)![1] as FormData;
    expect(form.get("document_type")).toBe("receipt");
    expect(api.post).not.toHaveBeenCalled();
    await waitFor(() => expect(currentUrl().pathname).toBe("/documents/doc-9"));
  });

  it("keeps the draft and shows the error inline when recognition fails", async () => {
    const view = await open();
    attachPhoto();
    await userEvent.click(review());
    await waitFor(() => expect(api.postForm).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    state.recognition = { id: "recognition-1", status: "failed", error: "Vision is offline." };
    view.refresh();
    expect(await screen.findByRole("alert")).toHaveTextContent("Vision is offline.");
    expect(screen.getByText("backpack.png")).toBeVisible();
    expect(review()).toBeEnabled();
  });

  it("blocks a photo together with a link and lets either be removed", async () => {
    await open();
    await userEvent.type(textbox(), "https://shop.example/osprey");
    attachPhoto();
    expect(
      screen.getByText("A link can't be read together with a photo — remove one."),
    ).toBeVisible();
    expect(review()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByText(/can't be read together/)).not.toBeInTheDocument();
    expect(review()).toBeEnabled();
  });

  it("attaches the first pasted image", async () => {
    await open();
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    fireEvent.paste(textbox(), { clipboardData: { files: [image], getData: () => "" } });
    expect(screen.getByText("pasted.png")).toBeVisible();
    expect(screen.getByText("Photo")).toBeVisible();
  });

  it("disables voice until transcription is configured", async () => {
    state.transcription = { configured: false, available: false };
    await open();
    expect(mic()).toHaveAttribute("aria-disabled", "true");
    expect(mic()).toHaveAccessibleDescription(
      "Voice needs transcription — set up in AI settings",
    );
    await userEvent.click(mic());
    expect(screen.getByRole("link", { name: "set up in AI settings" })).toHaveAttribute(
      "href",
      "/settings/ai",
    );
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("disables voice while the box has content", async () => {
    await open();
    expect(mic()).not.toHaveAttribute("aria-disabled");
    await userEvent.type(textbox(), "Chairs");
    expect(mic()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(mic());
    expect(
      screen.getByText("Voice is sent on its own — clear the box to record.", {
        selector: "p",
      }),
    ).toBeVisible();
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("uploads a recording, imports its transcript and opens the review", async () => {
    const view = await open(officeBox);
    await userEvent.click(mic());
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith("/voice", expect.any(FormData)),
    );
    const upload = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(upload.get("file")).toBeInstanceOf(File);
    expect(upload.get("duration_seconds")).toBe("4");
    expect(upload.get("location_id")).toBe("box-1");
    expect(await screen.findByText(/Transcribing your voice note/)).toBeVisible();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();

    state.voiceNote = { id: "note-1", status: "transcribed", transcript: "One stove" };
    view.refresh();
    await waitFor(() =>
      expect(api.postForm).toHaveBeenCalledWith("/imports", expect.any(FormData)),
    );
    const form = vi.mocked(api.postForm).mock.calls[1]![1] as FormData;
    expect(form.get("text")).toBe("One stove");
    expect(form.get("room_id")).toBe("room-1");
    await waitFor(() => expect(currentUrl().pathname).toBe("/imports/batch-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the context chip and edits it inline", async () => {
    await open(officeBox);
    await userEvent.click(screen.getByRole("button", { name: /Place: Office · BOX-001/ }));
    const picker = screen.getByRole("group", { name: "Where are these items?" });
    expect(within(picker).queryByLabelText("Property")).not.toBeInTheDocument();
    expect(within(picker).getByLabelText("Room")).toHaveValue("room-1");
    expect(within(picker).getByLabelText("Place")).toHaveValue("box-1");
    await userEvent.selectOptions(within(picker).getByLabelText("Room"), "room-2");
    await userEvent.selectOptions(within(picker).getByLabelText("Place"), "shelf-1");
    await userEvent.click(within(picker).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: /Place: Garage · Shelf/ })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Place: Garage/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: /Place: No place yet/ })).toBeVisible();
  });

  it("uses a popover for the context on desktop and keeps the draft visible", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query === "(min-width: 1024px)",
    })) as typeof window.matchMedia;
    try {
      await open(officeBox);
      expect(textbox()).toHaveFocus();
      await userEvent.type(textbox(), "Chairs");
      await userEvent.click(screen.getByRole("button", { name: /Place: Office/ }));
      expect(screen.getByRole("group", { name: "Where are these items?" })).toBeVisible();
      expect(textbox()).toHaveValue("Chairs");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("group", { name: "Where are these items?" })).toBeNull();
      expect(screen.getByRole("dialog", { name: "Add items" })).toBeVisible();
    } finally {
      window.matchMedia = original;
    }
  });

  it("shows the property choice only when there are several", async () => {
    state.properties = [
      { id: "home", name: "Home" },
      { id: "cabin", name: "Cabin" },
    ];
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Place:/ }));
    expect(screen.getByLabelText("Property")).toBeVisible();
  });

  it("links to the manual form with the context and origin", async () => {
    await open(officeBox);
    await userEvent.click(screen.getByRole("link", { name: "or fill in the form yourself" }));
    await waitFor(() => {
      const url = currentUrl();
      expect(url.pathname).toBe("/items/new");
      expect(url.searchParams.get("room_id")).toBe("room-1");
      expect(url.searchParams.get("location_id")).toBe("box-1");
      expect(url.searchParams.get("from")).toBe("/");
      expect(url.searchParams.get("from_label")).toBe("Office · BOX-001");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses page-registered context for the global Add items button", async () => {
    renderAddItems({ register: true });
    await userEvent.click(screen.getByRole("button", { name: "Add items" }));
    expect(screen.getByRole("button", { name: /Place: Office · BOX-009/ })).toBeVisible();
  });

  it("closes with Escape and restores focus to the trigger", async () => {
    renderAddItems();
    const trigger = screen.getByRole("button", { name: "Add items" });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    expect(screen.getByRole("heading", { name: "Add items" })).toHaveFocus();
    expect(textbox()).not.toHaveFocus();
  });

  it("opens the overlay from an /add-items deep link with its context", async () => {
    renderAddItems({ initialEntry: "/add-items?room_id=room-2&location_id=shelf-1" });
    expect(await screen.findByRole("dialog", { name: "Add items" })).toBeVisible();
    expect(currentUrl().pathname).toBe("/");
    expect(screen.getByRole("button", { name: /Place: Garage · Shelf/ })).toBeVisible();
  });
});
