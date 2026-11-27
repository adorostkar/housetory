import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ReviewRow } from "@/components/review-row";
import { BarEditorBoundary } from "@/components/shell/bar-editor";

// The bar editor takes the focus and selects the old value one frame after it opens.
async function barField() {
  const field = within(await screen.findByTestId("bar-editor")).getByRole("textbox");
  await waitFor(() => expect(field).toHaveFocus());
  return field;
}

function Row({ onTitle = vi.fn(), onSerial = vi.fn() }: {
  onTitle?: (value: string) => void;
  onSerial?: (value: string) => void;
}) {
  const [selected, setSelected] = React.useState(false);
  const [title, setTitle] = React.useState("Ladder");
  const [quantity, setQuantity] = React.useState("1");
  return (
    <ReviewRow
      number={2}
      title={title}
      titleLabel="Name of Ladder"
      onTitleChange={(value) => { onTitle(value); setTitle(value); }}
      titleValidate={(value) => (value ? null : "Give this item a name.")}
      quantity={quantity}
      onQuantityChange={setQuantity}
      quantityValidate={(value) => (/^\d+$/.test(value) ? null : "Enter a whole number, 0 or more.")}
      checks={["Room “Attic” is new"]}
      values={[
        { label: "Serial", value: "SN-1", edit: { description: "Serial number of Ladder", value: "SN-1", onCommit: onSerial } },
        { label: "Place", value: "Attic (new)", uncertain: true },
      ]}
      selection={{ checked: selected, onChange: setSelected, label: "Select Ladder" }}
      primary={{ label: "Add item", onClick: () => undefined }}
      onSkip={() => undefined}
    />
  );
}

describe("ReviewRow", () => {
  it("marks a selected row with a background and a bar, not only with its checkbox", async () => {
    render(<Row />);
    const row = screen.getByRole("article", { name: "Ladder" });
    expect(row).not.toHaveAttribute("data-selected");
    expect(row).not.toHaveClass("bg-accent");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Ladder" }));
    expect(row).toHaveAttribute("data-selected", "true");
    expect(row).toHaveClass("bg-accent", "border-primary");
    expect(screen.getByRole("checkbox", { name: "Select Ladder" })).toBeChecked();
    // Warnings on the highlight are written in the text colour; only the icon is brass.
    expect(within(row).getByText("Check: Room “Attic” is new").closest("p")).toHaveClass("text-foreground");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Ladder" }));
    expect(row).not.toHaveAttribute("data-selected");
  });

  it("shows the number of a finding", () => {
    render(<Row />);
    expect(screen.getByLabelText("Finding 2")).toHaveTextContent("2");
  });

  it("edits name and quantity in the row itself where there is no bar", async () => {
    const onTitle = vi.fn();
    render(<Row onTitle={onTitle} />);
    const name = screen.getByRole("textbox", { name: "Name of Ladder" });
    await userEvent.type(name, "s");
    expect(onTitle).toHaveBeenLastCalledWith("Ladders");
    expect(screen.getByRole("spinbutton", { name: /^Quantity of/ })).toHaveValue(1);
    // A value that has no field in the row stays text; it is changed in the editor.
    expect(screen.queryByRole("button", { name: "Edit serial number of Ladder" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
  });

  it("opens a tapped value in the bar editor and saves it into the draft", async () => {
    const onTitle = vi.fn();
    const onSerial = vi.fn();
    render(<BarEditorBoundary><Row onTitle={onTitle} onSerial={onSerial} /></BarEditorBoundary>);
    expect(screen.queryByRole("textbox", { name: "Name of Ladder" })).not.toBeInTheDocument();

    const nameButton = screen.getByRole("button", { name: "Edit name of Ladder" });
    await userEvent.click(nameButton);
    const field = await barField();
    expect(field).toHaveValue("Ladder");

    // A value that is not valid keeps the editor open and says why. Nothing is saved.
    await userEvent.clear(field);
    await userEvent.keyboard("{Enter}");
    expect(within(screen.getByTestId("bar-editor")).getByRole("alert")).toHaveTextContent("Give this item a name.");
    expect(onTitle).not.toHaveBeenCalled();

    await userEvent.type(field, "Step ladder{Enter}");
    expect(onTitle).toHaveBeenCalledExactlyOnceWith("Step ladder");
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Step ladder" })).toBeVisible();

    // Quantity and the other values of the closed row work the same way.
    await userEvent.click(screen.getByRole("button", { name: "Edit quantity of Step ladder" }));
    const quantity = await barField();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "two{Enter}");
    expect(within(screen.getByTestId("bar-editor")).getByRole("alert")).toHaveTextContent("Enter a whole number");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "3{Enter}");
    expect(screen.getByRole("button", { name: "Edit quantity of Step ladder" })).toHaveTextContent("×3");

    await userEvent.click(screen.getByRole("button", { name: "Edit serial number of Ladder" }));
    await userEvent.keyboard("{Escape}");
    expect(onSerial).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Edit serial number of Ladder" }));
    const serial = await barField();
    await userEvent.clear(serial);
    await userEvent.type(serial, "SN-1-B{Enter}");
    expect(onSerial).toHaveBeenCalledExactlyOnceWith("SN-1-B");
  });
});
