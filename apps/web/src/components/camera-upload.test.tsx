import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CameraUpload } from "@/components/camera-upload";

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: vi.fn(),
  });
});

function photoFile(name = "photo.jpg") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

describe("CameraUpload", () => {
  it("previews a camera capture, supports cancel and retake without uploading", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CameraUpload label="Item photograph" onUpload={onUpload} />,
    );
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    expect(cameraInput).not.toBeNull();
    expect(cameraInput).toHaveAttribute("accept", "image/*");

    fireEvent.change(cameraInput as HTMLInputElement, {
      target: { files: [photoFile()] },
    });
    expect(
      await screen.findByRole("img", { name: "Captured photograph preview" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();

    fireEvent.change(cameraInput as HTMLInputElement, {
      target: { files: [photoFile("retake.jpg")] },
    });
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Retake" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("uploads the reviewed photograph and exposes a library picker", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CameraUpload label="Item photograph" onUpload={onUpload} />,
    );
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    const file = photoFile("approved.jpg");
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: { files: [file] },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Choose photo" })).toBeVisible();
  });
});
