import { describe, expect, it } from "vitest";
import { assistantAnswerText, mergeToolRun, toolRunMessages, type AssistantToolRun } from "@/lib/assistant-tools";
import { followUpSuggestions } from "@/lib/assistant-followups";

describe("durable assistant observations", () => {
  it("keeps readable formatting while moving technical identifiers and paths out of answers", () => {
    const id = "492cc387-1ac5-4db4-b4b2-204e2806e784";
    expect(assistantAnswerText(
      `**Drill** is in *Kitchen* (item_id: ${id}).\nitem_id: ${id}\nGET /api/v1/items/${id}\n\`\`\`json\n{"batch_state":"paused"}\n\`\`\``,
    )).toBe("**Drill** is in *Kitchen*.");
    expect(assistantAnswerText(`See [the drill](/items/${id}).`)).toBe("See the drill.");
    expect(followUpSuggestions(undefined, "Do a review")).toEqual([]);
  });

  it("keeps the editable return authoritative instead of repeating model-authored proposal details", () => {
    const run: AssistantToolRun = {
      id: "run", query: "Mark it returned", household_id: "home", property_id: null,
      parent_id: null, generation: 1, state: "awaiting_approval", message: "Long duplicated fields",
      steps: [{ call: { name: "prepare_action", arguments: {} }, result: {
        summary: "Internal proposal details", references: [],
        proposal: {
          id: "proposal", kind: "return_loan", state: "ready", scope_label: "Home",
          targets: [{ id: "item", name: "Drill" }], before: {}, changes: { quantity: 1 }, destination: null,
        },
      } }],
      model_calls: 2, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    const action = toolRunMessages(run).find((message) => message.action);
    expect(action?.text).toBe("Review this return, then Apply to record it.");
    expect(action?.action?.proposal.changes).toEqual({ quantity: 1 });
  });

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
