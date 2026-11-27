import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { BarEditorBoundary, useBarEditor } from "@/components/shell/bar-editor";

function Finding({ label, start, onSaved }: { label: string; start: string; onSaved?: (value: string) => void }) {
  const editor = useBarEditor();
  const [value, setValue] = React.useState(start);
  const ref = React.useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() =>
        editor?.edit({
          label,
          description: `${label} of finding 1`,
          value,
          validate: (next) => (next ? null : `${label} is needed.`),
          onCommit: (next) => {
            setValue(next);
            onSaved?.(next);
          },
          returnFocus: ref.current,
        })
      }
    >
      {label}: {value}
    </button>
  );
}

describe("BarEditorBoundary", () => {
  it("edits a tapped value in the bar, saves on Enter and gives focus back", async () => {
    const onSaved = vi.fn();
    render(
      <BarEditorBoundary>
        <Finding label="Name" start="Drill" onSaved={onSaved} />
      </BarEditorBoundary>,
    );
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Name: Drill" }));
    const field = await screen.findByRole("textbox", { name: "Name of finding 1" });
    expect(field).toHaveValue("Drill");
    await userEvent.clear(field);
    await userEvent.type(field, "Cordless drill{Enter}");

    expect(onSaved).toHaveBeenCalledWith("Cordless drill");
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
    const value = screen.getByRole("button", { name: "Name: Cordless drill" });
    await vi.waitFor(() => expect(value).toHaveFocus());
  });

  it("keeps the editor open with the reason when the value is not valid, and Escape cancels", async () => {
    const onSaved = vi.fn();
    render(
      <BarEditorBoundary>
        <Finding label="Name" start="Drill" onSaved={onSaved} />
      </BarEditorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Name: Drill" }));
    const field = await screen.findByRole("textbox", { name: "Name of finding 1" });
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Name is needed.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(onSaved).not.toHaveBeenCalled();

    await userEvent.type(field, "x{Escape}");
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Name: Drill" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("saves the open value before moving to another one", async () => {
    render(
      <BarEditorBoundary>
        <Finding label="Name" start="Drill" />
        <Finding label="Quantity" start="1" />
      </BarEditorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Name: Drill" }));
    const name = await screen.findByRole("textbox", { name: "Name of finding 1" });
    await userEvent.clear(name);
    await userEvent.type(name, "Saw");
    await userEvent.click(screen.getByRole("button", { name: "Quantity: 1" }));

    expect(await screen.findByRole("textbox", { name: "Quantity of finding 1" })).toHaveValue("1");
    expect(screen.getByRole("button", { name: "Name: Saw" })).toBeInTheDocument();
  });

  it("is absent outside a boundary, so callers can edit in place", () => {
    function Probe() {
      return <output>{useBarEditor() === null ? "none" : "editor"}</output>;
    }
    render(<Probe />);
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("saves the open value before another control hears its click", async () => {
    const seen: string[] = [];
    function Row() {
      const editor = useBarEditor();
      const [name, setName] = React.useState("Ladder");
      return (
        <>
          <button
            type="button"
            onClick={() => editor?.edit({ label: "Name", description: "Name of finding 1", value: name, onCommit: setName })}
          >
            Name: {name}
          </button>
          <button type="button" onClick={() => seen.push(name)}>Add item</button>
        </>
      );
    }
    render(
      <BarEditorBoundary>
        <Row />
      </BarEditorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Name: Ladder" }));
    const field = await screen.findByRole("textbox", { name: "Name of finding 1" });
    await userEvent.clear(field);
    await userEvent.type(field, "Step ladder");
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));

    expect(seen).toEqual(["Step ladder"]);
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
  });

  it("holds back a click elsewhere while the open value is not valid", async () => {
    const onAdd = vi.fn();
    render(
      <BarEditorBoundary>
        <Finding label="Name" start="Drill" />
        <button type="button" onClick={onAdd}>Add item</button>
      </BarEditorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Name: Drill" }));
    const field = await screen.findByRole("textbox", { name: "Name of finding 1" });
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is needed.");
    expect(field).toHaveFocus();
  });

  it("closes without saving when the page changes", async () => {
    const onSaved = vi.fn();
    const view = render(
      <BarEditorBoundary resetKey="/imports/1">
        <Finding label="Name" start="Drill" onSaved={onSaved} />
      </BarEditorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Name: Drill" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name of finding 1" }), " press");
    view.rerender(
      <BarEditorBoundary resetKey="/items">
        <Finding label="Name" start="Drill" onSaved={onSaved} />
      </BarEditorBoundary>,
    );
    await vi.waitFor(() => expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
