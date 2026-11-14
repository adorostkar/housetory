import { describe, expect, it } from "vitest";

import { documentFileError, MAX_DOCUMENT_UPLOAD_BYTES } from "@/lib/document-files";

describe("documentFileError", () => {
  it("rejects unsupported and oversized files before upload", () => {
    expect(documentFileError(new File(["x"], "archive.zip", { type: "application/zip" })))
      .toContain("Choose a PDF");
    const oversized = new File(
      [new Uint8Array(MAX_DOCUMENT_UPLOAD_BYTES + 1)],
      "large.pdf",
      { type: "application/pdf" },
    );
    expect(documentFileError(oversized)).toContain("25 MB upload limit");
  });
});
