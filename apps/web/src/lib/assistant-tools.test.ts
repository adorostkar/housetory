import { describe, expect, it } from "vitest";
import { mergeToolRun, type AssistantToolRun } from "@/lib/assistant-tools";

describe("durable assistant observations", () => {
  it("does not regress a completed poll when an older create response arrives late", () => {
    const completed: AssistantToolRun = {
      id: "run", query: "Where is my drill?", household_id: "home", property_id: null,
      parent_id: null, generation: 1, state: "completed", message: "Found your drill.",
      steps: [], model_calls: 3, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    const restored = mergeToolRun([], completed);
    const messages = mergeToolRun(restored, {
      ...completed, state: "queued", model_calls: 0, message: "Waiting for the worker.",
    });
    expect(messages.at(-1)?.toolRun?.state).toBe("completed");
    expect(messages.at(-1)?.text).toBe("Found your drill.");
    const retry = mergeToolRun(messages, { ...completed, generation: 2, state: "queued" });
    expect(retry.at(-1)?.toolRun?.state).toBe("queued");
  });
});
