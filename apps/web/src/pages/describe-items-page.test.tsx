import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DescribeItemsPage } from "@/pages/describe-items-page";
import { api } from "@/lib/api";

const state = vi.hoisted(() => ({
  recognition: null as any,
  voiceNote: null as any,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/voice-recorder", () => ({
  VoiceRecorder: () => <div>Voice recorder</div>,
}));
vi.mock("@/components/camera-upload", () => ({
  CameraUpload: ({ onUpload }: { onUpload: (file: File) => Promise<void> }) => (
    <button
      type="button"
      onClick={() =>
        void onUpload(new File(["image"], "backpack.png", { type: "image/png" }))
      }
    >
      Add a photo
    </button>
  ),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn(), postForm: vi.fn() },
  };
});
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useProperties: () => ({ data: { items: [] } }),
    useRooms: () => ({ data: { items: [] } }),
    useLocations: () => ({ data: { items: [] } }),
    useRecognition: () => ({ data: state.recognition }),
    useVoiceNote: () => ({ data: state.voiceNote }),
    useVoiceConfig: () => ({ data: null }),
    useAiStatus: () => ({ data: { configured: false, available: false } }),
  };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/add-items"]}>
        <DescribeItemsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, refresh: () => view.rerender(ui()) };
}

beforeEach(() => {
  state.recognition = null;
  state.voiceNote = null;
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockImplementation(async (path) => {
    if (path === "/ai/recognitions") return { id: "recognition-1" };
    return { id: "batch-1", entries: [] };
  });
  vi.mocked(api.post).mockResolvedValue({ id: "batch-1", entries: [] });
});

describe("DescribeItemsPage", () => {
  it("submits plain text to the ordinary import review", async () => {
    renderPage();
    await userEvent.type(
      screen.getByLabelText("What did you get?"),
      "Two camping chairs in the garage",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review items" }));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledWith("/imports", expect.any(FormData)));
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("text")).toBe("Two camping chairs in the garage");
    expect(form.get("product_url")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/imports/batch-1"),
    );
  });

  it("submits one product URL and its explicit purchase date", async () => {
    renderPage();
    await userEvent.type(
      screen.getByLabelText("What did you get?"),
      "https://shop.example/osprey-jet-18",
    );
    await userEvent.type(screen.getByLabelText(/Purchase date/), "2026-10-15");
    await userEvent.click(screen.getByRole("button", { name: "Review items" }));
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("product_url")).toBe("https://shop.example/osprey-jet-18");
    expect(form.get("purchase_date")).toBe("2026-10-15");
    expect(form.get("text")).toBeNull();
  });

  it("sends image and edited context through recognition into the same review", async () => {
    const view = renderPage();
    await userEvent.type(screen.getByLabelText("What did you get?"), "Blue backpack on the left");
    await userEvent.click(screen.getByRole("button", { name: "Add a photo" }));
    await userEvent.click(screen.getByRole("button", { name: "Review items" }));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledWith("/ai/recognitions", expect.any(FormData)));
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("text")).toBe("Blue backpack on the left");
    expect(form.get("file")).toBeInstanceOf(File);
    await act(async () => {
      await Promise.resolve();
    });

    state.recognition = { id: "recognition-1", status: "succeeded" };
    view.refresh();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/imports/from-recognition/recognition-1"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/imports/batch-1"),
    );
  });

  it("puts a transcript into the editable draft without calling voice interpretation", async () => {
    state.voiceNote = {
      id: "note-1",
      status: "transcribed",
      transcript: "One camping stove in the garage",
    };
    renderPage();
    expect(await screen.findByDisplayValue("One camping stove in the garage")).toBeVisible();
    expect(api.post).not.toHaveBeenCalledWith("/voice/note-1/interpret", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Review items" }));
    const form = vi.mocked(api.postForm).mock.calls[0]![1] as FormData;
    expect(form.get("text")).toBe("One camping stove in the garage");
  });
});
