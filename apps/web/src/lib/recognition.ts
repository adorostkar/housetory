import type { AiRecognition } from "@/lib/types";

export type RecognitionPath = "vision" | "ocr" | "none" | "failed" | "unavailable";

const MODE_LABELS = {
  local: "Local",
  private: "Private network",
  cloud: "Remote/cloud",
  deterministic: "Deterministic",
  unavailable: "Unavailable",
} as const;

export function recognitionPath(recognition: AiRecognition): RecognitionPath {
  if (recognition.processing_path) return recognition.processing_path;
  if (recognition.status === "failed") return "failed";
  const suggestions = recognition.result.suggestions ?? [];
  if (suggestions.some((suggestion) => suggestion.source === "vision")) return "vision";
  if (suggestions.some((suggestion) => suggestion.source === "ocr")) return "ocr";
  if (suggestions.length > 0) return "none";
  return recognition.processing_mode === "unavailable" ? "unavailable" : "none";
}

export function recognitionProcessing(recognition: AiRecognition) {
  const path = recognitionPath(recognition);
  const mode = recognition.processing_mode
    ? MODE_LABELS[recognition.processing_mode]
    : "Unavailable";
  const model = [recognition.model_provider, recognition.model_name]
    .filter(Boolean)
    .join(" · ");
  const warnings = recognition.result.warnings ?? [];

  if (path === "vision") {
    return {
      path,
      label: "Vision",
      detail: [mode, model].filter(Boolean).join(" · "),
      variant: "sage" as const,
      warnings,
    };
  }
  if (path === "ocr") {
    return {
      path,
      label: "OCR text fallback",
      detail: "Readable text only; no vision suggestions were used.",
      variant: "brass" as const,
      warnings,
    };
  }
  if (path === "failed") {
    return {
      path,
      label: "Recognition failed",
      detail: recognition.error ?? "Try another photograph or configure AI.",
      variant: "destructive" as const,
      warnings,
    };
  }
  if (path === "none") {
    return {
      path,
      label: "No suggestions",
      detail: "The vision model returned no usable object suggestions.",
      variant: "outline" as const,
      warnings,
    };
  }
  return {
    path,
    label: "Vision unavailable",
    detail: recognition.error ?? "No vision task is configured.",
    variant: "outline" as const,
    warnings,
  };
}
