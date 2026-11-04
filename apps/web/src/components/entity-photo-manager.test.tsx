import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EntityPhotoManager } from "@/components/entity-photo-manager";
import type { Photo } from "@/lib/types";

const photoState = vi.hoisted(() => ({
  photos: [] as Photo[],
  canWrite: true,
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => photoState.canWrite,
    useRoomPhotos: () => ({
      data: { items: photoState.photos },
      isPending: false,
    }),
    useLocationPhotos: () => ({
      data: { items: photoState.photos },
      isPending: false,
    }),
  };
});

function photo(id: string): Photo {
  return {
    id,
    original_filename: `${id}.png`,
    content_type: "image/png",
    byte_size: 100,
    width: 800,
    height: 600,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    url: `/photos/${id}`,
    thumbnail_url: `/photos/${id}/thumbnail`,
  };
}

function renderManager(kind: "room" | "location" = "room") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EntityPhotoManager kind={kind} entityId="entity-1" name="Office" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  photoState.photos = [];
  photoState.canWrite = true;
});

describe("EntityPhotoManager", () => {
  it("uses one compact upload control group when empty", () => {
    renderManager();
    expect(screen.getByText("Add a photograph")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose photo" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Take a photo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a photo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^View photograph/ })).not.toBeInTheDocument();
  });

  it("shows a bounded cover and one thumbnail group for a single photo", () => {
    photoState.photos = [photo("photo-1")];
    renderManager();
    expect(
      screen.getByRole("button", { name: "View Office photograph full screen" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "View photograph 1" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take a photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose a photo" })).toHaveLength(1);
    expect(screen.queryByText("Add a photograph")).not.toBeInTheDocument();
  });

  it("keeps photos visible but hides upload and edit controls for viewers", () => {
    photoState.canWrite = false;
    photoState.photos = [photo("photo-1")];
    renderManager();
    expect(
      screen.getByRole("button", { name: "View Office photograph full screen" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "View photograph 1" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take a photo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a photo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move photograph earlier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete photograph" })).not.toBeInTheDocument();
  });

  it("shows compact thumbnails for multiple photos on containers too", () => {
    photoState.photos = [photo("photo-1"), photo("photo-2"), photo("photo-3")];
    renderManager("location");
    expect(screen.getByRole("button", { name: "View photograph 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View photograph 2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View photograph 3" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Take a photo" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose a photo" })).toHaveLength(1);
  });
});
