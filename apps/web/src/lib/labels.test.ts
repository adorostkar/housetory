import { describe, expect, it } from "vitest";

import {
  DOCUMENT_TYPE_LABELS,
  WARRANTY_STATUS_LABELS,
  warrantyRemainingLabel,
} from "@/lib/labels";
import { addMonthsIso } from "@/lib/utils";

describe("ownership labels", () => {
  it("calculates warranty months with calendar clamping", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsIso("2026-02-01", 24)).toBe("2028-02-01");
    expect(addMonthsIso("not-a-date", 2)).toBeNull();
  });

  it("describes remaining warranty time", () => {
    expect(warrantyRemainingLabel(10, "expiring")).toBe("10 days remaining");
    expect(warrantyRemainingLabel(0, "expiring")).toBe("Ends today");
    expect(warrantyRemainingLabel(-2, "expired")).toBe("Expired 2 days ago");
    expect(warrantyRemainingLabel(null, "unknown")).toBe("No end date");
  });

  it("labels every document and warranty type", () => {
    expect(Object.keys(DOCUMENT_TYPE_LABELS)).toEqual([
      "receipt",
      "invoice",
      "warranty_certificate",
      "manual",
      "specification",
      "other",
    ]);
    expect(WARRANTY_STATUS_LABELS.expiring).toBe("Expiring soon");
  });
});
