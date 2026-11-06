import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/components/model-picker";
import type { AiProviderModel } from "@/lib/types";

function model(overrides: Partial<AiProviderModel>): AiProviderModel {
  return {
    id: "model-id",
    display_name: "Model",
    kind: "chat",
    capabilities: ["text"],
    capability_source: "heuristic",
    ...overrides,
  };
}

const catalog: AiProviderModel[] = [
  model({
    id: "gpt-4o",
    display_name: "GPT-4o",
    capabilities: ["text", "vision", "structured", "tools"],
    capability_source: "provider_metadata",
  }),
  model({ id: "gpt-4o-mini", display_name: "GPT-4o mini", capabilities: ["text"] }),
  model({
    id: "text-embedding-3-small",
    display_name: "Text embedding 3 small",
    kind: "embedding",
    capabilities: [],
  }),
  model({ id: "text-only", display_name: "Text Only", capabilities: ["text"] }),
  model({
    id: "gpt-image-test",
    display_name: "Image Generation",
    kind: "image",
    capabilities: ["image"],
  }),
  model({
    id: "whisper-test",
    display_name: "Whisper Test",
    kind: "speech",
    capabilities: ["audio"],
  }),
  model({
    id: "audio-chat",
    display_name: "Audio Chat",
    kind: "chat",
    capabilities: ["text", "audio"],
  }),
];

function Harness({
  initial = "",
  requiredCapability,
  models = catalog,
  loading = false,
  error = null,
  onRetry,
  onDiscover,
}: {
  initial?: string;
  requiredCapability?: string;
  models?: AiProviderModel[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onDiscover?: () => void;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <div>
      <ModelPicker
        id="test-model"
        ariaLabel="Test model"
        value={value}
        models={models}
        requiredCapability={requiredCapability}
        loading={loading}
        error={error}
        onChange={setValue}
        onRefresh={onRetry}
        onDiscover={onDiscover}
      />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe("ModelPicker", () => {
  it("filters a large catalog and selects with keyboard navigation", async () => {
    const models = Array.from({ length: 500 }).map((_, index) =>
      model({
        id: `model-${index}`,
        display_name: `Model ${index}`,
      }),
    );
    render(<Harness models={models} />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText(/Showing 50 of 500/)).toBeVisible();
    await userEvent.type(input, "model-447");
    expect(screen.getByRole("option", { name: /Model 447/ })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("value")).toHaveTextContent("model-447"),
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("filters non-chat and incompatible models for a vision task", async () => {
    render(<Harness requiredCapability="vision" />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("GPT-4o");
    expect(screen.queryByText("Text Only")).not.toBeInTheDocument();
    expect(screen.queryByText("Text embedding 3 small")).not.toBeInTheDocument();
  });

  it("filters image-output models for item illustrations", async () => {
    render(<Harness requiredCapability="image" />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Image Generation");
    expect(screen.queryByText("Whisper Test")).not.toBeInTheDocument();
    expect(screen.queryByText("Text Only")).not.toBeInTheDocument();
  });

  it("filters audio-capable chat and speech models for transcription", async () => {
    render(<Harness requiredCapability="audio" />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.getByText("Whisper Test")).toBeInTheDocument();
    expect(screen.getByText("Audio Chat")).toBeInTheDocument();
    expect(screen.queryByText("Image Generation")).not.toBeInTheDocument();
    expect(screen.queryByText("Text Only")).not.toBeInTheDocument();
  });

  it("preserves an unlisted saved selection and allows exact-ID fallback", async () => {
    render(<Harness initial="saved-private-model" />);
    expect(screen.getByText(/Saved model is not listed/)).toBeVisible();
    expect(screen.getByTestId("value")).toHaveTextContent("saved-private-model");

    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    await userEvent.type(input, "private/custom-model");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("value")).toHaveTextContent("private/custom-model"),
    );
  });

  it("shows heuristic capability provenance and Escape closes the panel", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    expect(screen.getAllByText("Heuristic — verify").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider metadata").length).toBeGreaterThan(0);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the selected value and reopens on click after Escape", async () => {
    render(<Harness initial="gpt-4o" />);
    const input = screen.getByRole("combobox", { name: "Test model" });
    await userEvent.click(input);
    expect(screen.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("GPT-4o");
    await userEvent.click(input);
    expect(screen.getByRole("listbox")).toBeVisible();
  });

  it("renders loading, empty, error and retry states", async () => {
    const retry = vi.fn();
    const discover = vi.fn();
    const { rerender } = render(<Harness loading />);
    await userEvent.click(screen.getByRole("combobox", { name: "Test model" }));
    expect(screen.getByText("Discovering models from the provider…")).toBeVisible();

    rerender(<Harness models={[]} onDiscover={discover} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Test model" }));
    expect(screen.getByText("No models discovered yet.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Discover models/ }));
    expect(discover).toHaveBeenCalled();

    rerender(<Harness error="Rate limited" onRetry={retry} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Test model" }));
    expect(screen.getByText("Rate limited")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry discovery" }));
    expect(retry).toHaveBeenCalled();
  });
});
