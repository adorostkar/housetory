import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSpeechDictation } from "./use-speech-dictation";

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
}

describe("useSpeechDictation", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  });

  it("reports unsupported without the API", () => {
    const { result } = renderHook(() => useSpeechDictation(() => {}));
    expect(result.current.supported).toBe(false);
  });

  it("emits final transcripts and toggles listening", () => {
    (window as unknown as Record<string, unknown>).SpeechRecognition =
      FakeRecognition;
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechDictation(onText));
    expect(result.current.supported).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.listening).toBe(true);

    act(() =>
      FakeRecognition.last?.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: " where is my drill " } }],
      }),
    );
    expect(onText).toHaveBeenCalledWith("where is my drill");

    act(() => result.current.toggle());
    expect(result.current.listening).toBe(false);
  });
});
