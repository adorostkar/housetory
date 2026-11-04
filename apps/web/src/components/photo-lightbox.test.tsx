import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PhotoLightbox } from "@/components/photo-lightbox";
import type { Photo } from "@/lib/types";

function photo(id: string, index: number): Photo {
  return {
    id,
    original_filename: `${id}.jpg`,
    content_type: "image/jpeg",
    byte_size: 1000,
    width: 800,
    height: 600,
    sort_order: index,
    created_at: "2026-01-01T00:00:00Z",
    url: `/api/v1/photos/${id}/file`,
    thumbnail_url: `/api/v1/photos/${id}/thumbnail`,
  };
}

describe("PhotoLightbox", () => {
  it("opens on the selected photo and navigates with controls and arrow keys", async () => {
    const onOpenChange = vi.fn();
    const onPhotoChange = vi.fn();
    render(
      <PhotoLightbox
        open
        onOpenChange={onOpenChange}
        photos={[photo("one", 0), photo("two", 1), photo("three", 2)]}
        initialPhotoId="two"
        onPhotoChange={onPhotoChange}
        itemName="Camera"
      />,
    );

    expect(screen.getByRole("img", { name: "Camera photograph 2" })).toHaveAttribute(
      "src",
      "/api/v1/photos/two/file",
    );

    await userEvent.click(screen.getByRole("button", { name: "Next photograph" }));
    expect(screen.getByRole("img", { name: "Camera photograph 3" })).toBeInTheDocument();
    expect(onPhotoChange).toHaveBeenLastCalledWith("three");

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "Camera photograph 1" })).toBeInTheDocument();
    expect(onPhotoChange).toHaveBeenLastCalledWith("one");

    await userEvent.click(screen.getByRole("button", { name: "Close photograph viewer" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when there are no photos", () => {
    const { container } = render(
      <PhotoLightbox
        open
        onOpenChange={vi.fn()}
        photos={[]}
        initialPhotoId={null}
        itemName="Camera"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
