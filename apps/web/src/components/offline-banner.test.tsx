import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OfflineBanner, OfflineBoundary, formatSavedAt, worksOffline } from "@/components/offline-banner";
import type { OfflineStatus } from "@/lib/offline/controller";

const status: OfflineStatus = {
  supported: true,
  enabled: true,
  photos: true,
  allowed: true,
  info: {
    userId: "user-1",
    householdId: "household-1",
    householdName: "Birch Lane",
    savedAt: new Date(2026, 10, 27, 14, 2).getTime(),
    itemCount: 3,
  },
  appReady: true,
  online: true,
  syncing: false,
  syncError: null,
  photoProgress: null,
};
let current = status;
const listeners = new Set<() => void>();
function setStatus(patch: Partial<OfflineStatus>) {
  current = { ...current, ...patch };
  act(() => listeners.forEach((listener) => listener()));
}

vi.mock("@/lib/offline/controller", async () => {
  const React = await import("react");
  return {
    checkConnection: vi.fn(() => Promise.resolve(false)),
    useOfflineStatus: () =>
      React.useSyncExternalStore(
        (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => current,
      ),
  };
});

afterEach(() => {
  current = status;
  listeners.clear();
});

function page(pathname: string) {
  return (
    <MemoryRouter>
      <OfflineBanner />
      <OfflineBoundary pathname={pathname}>
        <p>the page</p>
      </OfflineBoundary>
    </MemoryRouter>
  );
}

describe("pages while the copy is shown", () => {
  it("knows which pages the copy can show", () => {
    for (const path of ["/", "/items", "/items/abc", "/rooms/abc", "/containers", "/settings/offline"]) {
      expect(worksOffline(path), path).toBe(true);
    }
    for (const path of ["/items/new", "/items/abc/edit", "/documents", "/loans", "/settings/household"]) {
      expect(worksOffline(path), path).toBe(false);
    }
  });

  it("says nothing while the server answers", () => {
    render(page("/documents"));
    expect(screen.getByText("the page")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("replaces a page that needs the server when it is opened offline", () => {
    current = { ...status, online: false };
    const view = render(page("/documents"));
    expect(screen.getByRole("status")).toHaveTextContent(/Offline\. You see your copy/);
    expect(screen.getByText("This page needs a connection")).toBeInTheDocument();
    expect(screen.queryByText("the page")).not.toBeInTheDocument();

    view.rerender(page("/items"));
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("keeps a page that was open when the connection went away, until it is left", () => {
    const view = render(page("/items/new"));
    setStatus({ online: false });
    // A form with unsaved text stays on the screen.
    expect(screen.getByText("the page")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    view.rerender(page("/documents"));
    expect(screen.queryByText("the page")).not.toBeInTheDocument();
    view.rerender(page("/items/new"));
    expect(screen.queryByText("the page")).not.toBeInTheDocument();

    setStatus({ online: true });
    expect(screen.getByText("the page")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

it("names the day only when the copy is not from today", () => {
  const savedAt = new Date(2026, 10, 27, 14, 2).getTime();
  expect(formatSavedAt(savedAt, new Date(2026, 10, 27, 20, 0))).toMatch(/^today at /);
  expect(formatSavedAt(savedAt, new Date(2026, 10, 29, 9, 0))).toMatch(/^on .*27.* at /);
});
