import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PersonNameInput } from "@/components/person-name-input";
import type { LoanPerson } from "@/lib/types";

const people = vi.hoisted(() => ({
  current: [] as LoanPerson[],
  calls: [] as string[],
}));

vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/lib/queries", () => ({
  useLoanPeople: (query: string) => {
    people.calls.push(query);
    return {
      data: { items: people.current, total: people.current.length },
      isPending: false,
      isError: false,
    };
  },
}));

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return (
    <div>
      <label htmlFor="person">Borrower</label>
      <PersonNameInput id="person" value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

const jack: LoanPerson = {
  name: "Jack",
  lent_open: 1,
  borrowed_open: 1,
  lent_total: 2,
  borrowed_total: 1,
  last_activity_on: "2026-01-01",
};

beforeEach(() => {
  people.calls = [];
  people.current = [jack];
});

describe("PersonNameInput", () => {
  it("suggests household names with both-direction counts and selects by keyboard", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Borrower" });
    await userEvent.type(input, "J");
    const option = await screen.findByRole("option", { name: /Jack/ });
    expect(option).toHaveTextContent("1 lent out");
    expect(option).toHaveTextContent("1 borrowed");

    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(input).toHaveValue("Jack"));
    expect(screen.getByTestId("value")).toHaveTextContent("Jack");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps direct new names without creating or rewriting anything", async () => {
    people.current = [];
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Borrower" });
    await userEvent.type(input, "New Neighbour");
    expect(input).toHaveValue("New Neighbour");
    expect(screen.getByTestId("value")).toHaveTextContent("New Neighbour");
    expect(screen.getByText(/saved only when you save the record/i)).toBeVisible();
  });

  it("selects with the pointer and closes on Escape", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Borrower" });
    await userEvent.click(input);
    const option = await screen.findByRole("option", { name: /Jack/ });
    await userEvent.click(option);
    await waitFor(() => expect(input).toHaveValue("Jack"));

    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });
});
