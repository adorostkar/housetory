import { describe, expect, it } from "vitest";
import {
  actionMessage, assistantAnswerText, isStopRequest, mergeToolRun, toolRunMessages, type AssistantToolRun,
} from "@/lib/assistant-tools";
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
    // Runs recorded before answers were separated keep their old prose out of view.
    expect(toolRunMessages(run).some((message) => message.toolAnswer)).toBe(false);
  });

  it("shows the rest of a mixed answer before the prepared action, without internal identifiers", () => {
    const loan = "492cc387-1ac5-4db4-b4b2-204e2806e784";
    const run: AssistantToolRun = {
      id: "run", query: "How long have they had it? Prepare a return for today.",
      household_id: "home", property_id: null, parent_id: null, generation: 1,
      state: "awaiting_approval",
      message: "Validation Borrower has had it for 3 days. Return of 1 is ready.",
      answer: `Validation Borrower has had it for **3 days** (loan_id: ${loan}).`,
      steps: [{ call: { name: "prepare_action", arguments: {} }, result: {
        summary: "Proposal ready. Nothing has been applied.", references: [],
        proposal: {
          id: "proposal", kind: "return_loan", state: "ready", scope_label: "Home",
          targets: [{ id: loan, name: "Drill · Validation Borrower" }], before: {},
          changes: { quantity: 1 }, destination: null,
        },
      } }],
      model_calls: 3, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    const messages = toolRunMessages(run);
    expect(messages.map((message) => message.toolAnswer ? "answer" : message.action ? "card"
      : message.toolRun ? "status" : "request")).toEqual(["request", "answer", "card", "status"]);
    expect(messages.slice(1, 3).map((message) => message.text)).toEqual([
      "Validation Borrower has had it for **3 days**.",
      "Review this return, then Apply to record it.",
    ]);
    // A card reopened on its own is replaced, not duplicated, when its task loads.
    const merged = mergeToolRun([actionMessage(run.steps[0]!.result.proposal!)], run);
    expect(merged.filter((message) => message.action)).toHaveLength(1);
    expect(merged.find((message) => message.action)?.toolRunId).toBe("run");
    // While the task is still being retried or has no extra answer, nothing is duplicated.
    expect(toolRunMessages({ ...run, answer: "" }).some((message) => message.toolAnswer)).toBe(false);
    expect(toolRunMessages({ ...run, state: "running" }).some((message) => message.toolAnswer)).toBe(false);
    // A card is not shown in the middle of a request: it appears when the request has ended.
    expect(toolRunMessages({ ...run, state: "running" }).some((message) => message.action)).toBe(false);
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
  it("treats only a whole stop word as a stop, and leaves every other message to the assistant", () => {
    expect(["stop", " Stop. ", "CANCEL!", "avbryt", "stopp"].map(isStopRequest)).toEqual(
      [true, true, true, true, true],
    );
    expect(["stop the loan to Sam", "don't stop", "cancel the proposal", "st"].map(isStopRequest))
      .toEqual([false, false, false, false]);
  });

  it("shows what the user added while it ran, and follows the server for an applied change", () => {
    const proposal = {
      id: "p-direct", kind: "edit_item", state: "applied", scope_label: "Home",
      targets: [{ id: "item-1", name: "Hammer drill" }], destination: null,
      changes: { name: "Hammer drill" }, before: { name: "Drill" },
      applied_directly: true, message: "Updated Hammer drill.",
      undo: { available: true, undone: false },
    };
    const run: AssistantToolRun = {
      id: "run-1", parent_id: null, household_id: "house-1", property_id: null,
      query: "Rename the drill", state: "completed", generation: 1, message: "Renamed.",
      answer: "Renamed.", steers: [{ id: "s1", text: "Call it Hammer drill" }],
      steps: [{
        call: { name: "prepare_action", arguments: {} },
        result: { summary: "Applied.", references: [], proposal },
      }],
      model_calls: 2, max_model_calls: 8, can_retry: false, worker_available: null,
    };
    const messages = toolRunMessages(run);
    // The message sent while the request ran is shown as the user's, in the same request.
    expect(messages.slice(0, 2).map(({ role, text }) => [role, text])).toEqual([
      ["user", "Rename the drill"], ["user", "Call it Hammer drill"],
    ]);
    const card = messages.find((message) => message.action);
    expect(card?.text).toBe("Done. This change was applied for you.");
    expect(card?.action?.result).toBe("Updated Hammer drill.");
    expect(card?.action?.proposal.undo?.available).toBe(true);

    // It was undone elsewhere. The card that already showed a result follows the server.
    const undone = {
      ...proposal, state: "undone", message: "Undone. Drill is as it was before.",
      undo: { available: false, undone: true },
    };
    const merged = mergeToolRun(messages, {
      ...run, steps: [{ ...run.steps[0]!, result: { ...run.steps[0]!.result, proposal: undone } }],
    });
    const after = merged.find((message) => message.action)?.action;
    expect(after?.result).toBe("Undone. Drill is as it was before.");
    expect(after?.proposal.undo).toEqual({ available: false, undone: true });
  });
});
