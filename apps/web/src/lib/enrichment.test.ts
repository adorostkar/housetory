import { describe, expect, it } from "vitest";

import { keepManualEdits } from "@/lib/enrichment";

describe("reviewing delayed AI suggestions", () => {
  it("keeps manual clears, quantities and nested edits while accepting untouched fields", () => {
    const base: {
      name: string; brand: string; quantity: number;
      purchase: { merchant: string; price_cents: number | null };
    } = {
      name: "Camera", brand: "Old brand", quantity: 1,
      purchase: { merchant: "Shop", price_cents: null },
    };
    const edited = {
      ...base, brand: "", quantity: 2,
      purchase: { merchant: "My shop", price_cents: null },
    };
    const suggested = {
      name: "Canon camera", brand: "Canon", quantity: 1,
      purchase: { merchant: "AI shop", price_cents: 5000 },
    };
    expect(keepManualEdits(base, edited, suggested)).toEqual({
      name: "Canon camera", brand: "", quantity: 2,
      purchase: { merchant: "My shop", price_cents: null },
    });
    expect(base.name).toBe("Camera");
  });
});
