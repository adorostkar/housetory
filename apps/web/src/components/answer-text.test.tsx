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
    expect(container.querySelector("strong")?.textContent).toBe("Heavy drill");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("answer-text")).toHaveAttribute("dir", "auto");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).toContain("در کارگاه است");
    expect(container.textContent).toContain("Home / Workshop / BOX-001");
  });

  it("uses the question direction and isolates preserved Latin names and paths", () => {
    const { container } = render(
      <AnswerText
        direction="rtl"
        preserveTerms={["Heavy drill", "DCD791", "Home / Workshop / BOX-001"]}
        text={
          "**Heavy drill** DCD791 در کارگاه است.\n\n- تعداد 2 عدد.\n- مسیر: Home / Workshop / BOX-001"
        }
      />,
    );
    expect(screen.getByTestId("answer-text")).toHaveAttribute("dir", "rtl");
    expect(container.querySelectorAll("bdi").length).toBeGreaterThanOrEqual(3);
    const isolated = Array.from(container.querySelectorAll("bdi")).map(
      (element) => element.textContent,
    );
    expect(isolated).toContain("Heavy drill");
    expect(isolated).toContain("DCD791");
    expect(isolated).toContain("Home / Workshop / BOX-001");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("keeps a normal English answer LTR", () => {
    render(
      <AnswerText
        direction="ltr"
        text={"Your **Heavy drill** is in the workshop.\n\n- Due 12 May 2027."}
      />,
    );
    expect(screen.getByTestId("answer-text")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText(/is in the workshop/)).toBeVisible();
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
