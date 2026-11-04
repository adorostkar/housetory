import { describe, expect, it } from "vitest";

import { recognitionPath, recognitionProcessing } from "@/lib/recognition";
import type { AiRecognition } from "@/lib/types";

function recognition(overrides: Partial<AiRecognition>): AiRecognition {
  return {
    id: "recognition-1",
    status: "succeeded",
    original_filename: "image.png",
    content_type: "image/png",
    width: 100,
    height: 100,
    result: { suggestions: [], warnings: [] },
    field_sources: {},
    confidence: null,
    error: null,
    model_provider: null,
    model_name: null,
    processing_mode: "deterministic",
    processing_path: "ocr",
    created_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:01Z",
    image_url: "/image",
    original_url: "/original",
    ...overrides,
  };
}

describe("recognition processing labels", () => {
  it("labels a real vision response with mode and model", () => {
    const result = recognitionProcessing(
      recognition({
        processing_mode: "cloud",
        processing_path: "vision",
        model_provider: "openrouter",
        model_name: "vision-model",
        result: {
          suggestions: [{ name: "Camera", quantity: 1, source: "vision" } as never],
          warnings: [],
        },
      }),
    );
    expect(result.path).toBe("vision");
    expect(result.label).toBe("Vision");
    expect(result.detail).toContain("Remote/cloud");
    expect(result.detail).toContain("openrouter");
    expect(result.detail).toContain("vision-model");
  });

  it("labels OCR fallback and keeps its reason visible", () => {
    const result = recognitionProcessing(
      recognition({
        result: {
          suggestions: [{ name: "Toaster", quantity: 1, source: "ocr" } as never],
          warnings: ["No vision task is configured."],
        },
      }),
    );
    expect(result.path).toBe("ocr");
    expect(result.label).toBe("OCR text fallback");
    expect(result.warnings).toEqual(["No vision task is configured."]);
  });

  it("distinguishes an empty vision response from OCR", () => {
    const result = recognitionProcessing(
      recognition({
        processing_mode: "cloud",
        processing_path: "none",
        result: { suggestions: [], warnings: ["No suggestions returned."] },
      }),
    );
    expect(result.path).toBe("none");
    expect(result.label).toBe("No suggestions");
  });

  it("labels unavailable and failed states", () => {
    const unavailable = recognitionProcessing(
      recognition({
        status: "queued",
        processing_mode: "unavailable",
        processing_path: "unavailable",
      }),
    );
    expect(unavailable.label).toBe("Vision unavailable");
    const failed = recognitionProcessing(
      recognition({
        status: "failed",
        error: "No readable text was found.",
        processing_path: "failed",
      }),
    );
    expect(failed.label).toBe("Recognition failed");
    expect(failed.detail).toContain("No readable text");
  });

  it("derives a path for records created before processing_path was added", () => {
    expect(
      recognitionPath(
        recognition({
          processing_path: undefined,
          result: {
            suggestions: [{ name: "Camera", quantity: 1, source: "vision" } as never],
            warnings: [],
          },
        }),
      ),
    ).toBe("vision");
  });
});
