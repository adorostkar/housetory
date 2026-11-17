import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { NavigationGuardProvider, useNavigationGuard } from "@/lib/navigation-guard";

function GuardedPage() {
  const navigate = useNavigate();
  const [text, setText] = React.useState("");
  const release = useNavigationGuard(text !== "");
  return (
    <div>
      <label htmlFor="note">Note</label>
      <input id="note" value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" onClick={() => navigate("/other", { replace: true })}>
        Go elsewhere
      </button>
      <button type="button" onClick={() => navigate({ hash: "#panel" })}>
        Open panel
      </button>
      <button
        type="button"
        onClick={() => {
          release();
          navigate("/other");
        }}
      >
        Save
      </button>
    </div>
  );
}

function renderApp() {
  return render(
    <BrowserRouter>
      <NavigationGuardProvider>
        <Routes>
          <Route path="/" element={<Link to="/guarded">Open guarded page</Link>} />
          <Route path="/guarded" element={<GuardedPage />} />
          <Route path="/other" element={<p>Other page</p>} />
        </Routes>
      </NavigationGuardProvider>
    </BrowserRouter>,
  );
}

async function openDirtyPage(user: ReturnType<typeof userEvent.setup>) {
  renderApp();
  await user.click(screen.getByRole("link", { name: "Open guarded page" }));
  await user.type(screen.getByLabelText("Note"), "draft text");
}

function goBack() {
  act(() => window.history.back());
}

beforeEach(() => {
  window.history.pushState(null, "", "/");
});

describe("NavigationGuardProvider", () => {
  it("holds programmatic navigation until the user confirms", async () => {
    const user = userEvent.setup();
    await openDirtyPage(user);

    await user.click(screen.getByRole("button", { name: "Go elsewhere" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(window.location.pathname).toBe("/guarded");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Note")).toHaveValue("draft text");

    await user.click(screen.getByRole("button", { name: "Go elsewhere" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByText("Other page")).toBeVisible();
    expect(window.location.pathname).toBe("/other");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("restores the URL when a guarded back navigation is cancelled", async () => {
    const user = userEvent.setup();
    await openDirtyPage(user);

    goBack();
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/guarded"));

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Note")).toHaveValue("draft text");
    expect(window.location.pathname).toBe("/guarded");

    goBack();
    await screen.findByRole("dialog");
    await waitFor(() => expect(window.location.pathname).toBe("/guarded"));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("link", { name: "Open guarded page" })).toBeVisible();
    expect(window.location.pathname).toBe("/");
  });

  it("lets navigation that stays on the same page through", async () => {
    const user = userEvent.setup();
    await openDirtyPage(user);

    await user.click(screen.getByRole("button", { name: "Open panel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#panel");
    expect(screen.getByLabelText("Note")).toHaveValue("draft text");

    goBack();
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Note")).toHaveValue("draft text");
  });

  it("does not prompt once the page has released its guard", async () => {
    const user = userEvent.setup();
    await openDirtyPage(user);

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Other page")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks the browser to confirm leaving the document only while dirty", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("link", { name: "Open guarded page" }));

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.type(screen.getByLabelText("Note"), "draft text");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
