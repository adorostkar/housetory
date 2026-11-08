import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerText } from "@/components/answer-text";

describe("AnswerText", () => {
  it("renders safe prose, bold and bullets with RTL-aware direction", () => {
    const { container } = render(
      <AnswerText
        text={
          "**Heavy drill** در کارگاه است.\n\n- یک واحد ثبت شده است.\n- قرض باز ثبت نشده است.\n\nمسیر: Home / Workshop / BOX-001"
        }
      />,
    );
    expect(screen.getByText("Heavy drill").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("answer-text")).toHaveAttribute("dir", "auto");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).toContain("در کارگاه است");
    expect(container.textContent).toContain("Home / Workshop / BOX-001");
  });

  it("never interprets raw HTML or markdown links", () => {
    const { container } = render(
      <AnswerText text={'<script>alert(1)</script> [unsafe](javascript:alert(1))'} />,
    );
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("a")).not.toBeInTheDocument();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("[unsafe](javascript:alert(1))");
  });
});
