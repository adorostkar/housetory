import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type LoanRecord = {
  id: string;
  borrower_name: string;
  item_name: string;
  status: string;
  outstanding_quantity: number;
};

type BorrowedRecord = {
  id: string;
  owner_name: string;
  item_name: string;
  status: string;
};

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", {
    headers: await headers(request),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
) {
  const response = await request.post("/api/v1/items", {
    headers: await headers(request),
    data: { name, room_id: roomId, quantity: 10 },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(
  request: APIRequestContext,
  itemId: string,
  borrowerName: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await request.post("/api/v1/loans", {
    headers: await headers(request),
    data: {
      item_id: itemId,
      borrower_name: borrowerName,
      quantity: 1,
      lent_on: "2026-01-01",
      due_on: "2026-01-10",
      request_id: crypto.randomUUID(),
      ...overrides,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as LoanRecord;
}

async function returnLoan(request: APIRequestContext, loanId: string) {
  const response = await request.post(`/api/v1/loans/${loanId}/returns`, {
    headers: await headers(request),
    data: {
      quantity: 1,
      returned_on: "2026-02-01",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function createBorrowed(
  request: APIRequestContext,
  itemName: string,
  ownerName: string,
) {
  const response = await request.post("/api/v1/borrowed", {
    headers: await headers(request),
    data: {
      item_name: itemName,
      owner_name: ownerName,
      quantity: 1,
      borrowed_on: "2026-01-01",
      due_on: "2026-01-10",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as BorrowedRecord;
}

async function returnBorrowed(request: APIRequestContext, recordId: string) {
  const response = await request.post(
    `/api/v1/borrowed/${recordId}/returns`,
    {
      headers: await headers(request),
      data: {
        quantity: 1,
        returned_on: "2026-02-01",
        request_id: crypto.randomUUID(),
      },
    },
  );
  expect(response.ok()).toBeTruthy();
}

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/simple-loan-names", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/simple-loan-names/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("loan name suggestions, person filters and individual corrections", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 1100 });

  const room = await createRoom(request, "Loan names E2E");
  const openItem = await createItem(request, "Open drill", room.id);
  const returnedItem = await createItem(request, "Returned cable", room.id);
  const johnItem = await createItem(request, "John ladder", room.id);
  const jamieItem = await createItem(request, "Jamie box", room.id);
  const jamieSecondItem = await createItem(request, "Jamie bin", room.id);

  const jackOpen = await createLoan(request, openItem.item.id, "Jack", {
    quantity: 2,
  });
  const jackReturned = await createLoan(
    request,
    returnedItem.item.id,
    "Jack",
  );
  await returnLoan(request, jackReturned.id);
  await createLoan(request, johnItem.item.id, "John");
  const jamieFirst = await createLoan(request, jamieItem.item.id, "Jamie");
  const jamieSecond = await createLoan(request, jamieSecondItem.item.id, "Jamie");

  const jackBorrowed = await createBorrowed(
    request,
    "Borrowed tile cutter",
    "Jack",
  );
  const jackBorrowedReturned = await createBorrowed(
    request,
    "Borrowed ladder",
    "Jack",
  );
  await returnBorrowed(request, jackBorrowedReturned.id);
  await createBorrowed(request, "Borrowed scanner", "John");

  await page.goto("/loans");
  const personFilter = page.getByLabel("Filter loans by person");
  await personFilter.click();
  await personFilter.fill("Jac");
  const jackOption = page.getByRole("option", { name: /Jack/ });
  await expect(jackOption).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(jackOption).toContainText("1 lent out");
  await expect(jackOption).toContainText("1 borrowed");
  await shot(page, "01-loans-person-suggestions");

  await personFilter.press("ArrowDown");
  await expect(jackOption).toHaveAttribute("aria-selected", "true");
  await personFilter.press("Enter");
  await expect(personFilter).toHaveValue("Jack");
  await expect(page).toHaveURL(/person=Jack/);
  await expect(page.getByText("to Jack")).toBeVisible();
  await expect(page.getByText("from Jack")).toBeVisible();
  await expect(
    page.getByText(/Showing lent-out and borrowed records for/),
  ).toContainText("Jack");
  await expect(page.getByText("Open drill")).toBeVisible();
  await expect(page.getByText("Borrowed tile cutter")).toBeVisible();
  await expect(page.getByText("Returned cable")).not.toBeVisible();
  await shot(page, "02-loans-jack-both-directions");

  await page.getByRole("tab", { name: "Returned" }).click();
  await expect(page.getByText("Returned cable")).toBeVisible();
  await expect(page.getByText("Borrowed ladder")).toBeVisible();
  await expect(page.getByText("Open drill")).not.toBeVisible();
  await expect(page.getByText("Borrowed tile cutter")).not.toBeVisible();

  await page
    .getByRole("tablist", { name: "Loan filters" })
    .getByRole("tab", { name: "All" })
    .click();
  await expect(page.getByText("Open drill")).toBeVisible();
  await expect(page.getByText("Returned cable")).toBeVisible();
  await expect(page.getByText("Borrowed tile cutter")).toBeVisible();
  await expect(page.getByText("Borrowed ladder")).toBeVisible();

  await page.getByRole("tab", { name: "Outstanding" }).click();
  await page.getByLabel("Past due only").click();
  await expect(page.getByLabel("Past due only")).toBeChecked();
  await expect(page.getByText("Open drill")).toBeVisible();
  await expect(page.getByText("Borrowed tile cutter")).toBeVisible();
  await page.getByLabel("Past due only").click();
  await expect(page.getByLabel("Past due only")).not.toBeChecked();

  // Detail back links retain the person query filter.
  await page
    .getByTestId("loan-row")
    .filter({ hasText: "Open drill" })
    .getByRole("link", { name: "View details" })
    .click();
  await expect(page.getByRole("heading", { name: "Jack" })).toBeVisible();
  await page.getByRole("link", { name: "All loans" }).click();
  await expect(page).toHaveURL(/person=Jack/);
  await expect(page.getByLabel("Filter loans by person")).toHaveValue("Jack");

  // Clearing the filter restores the unfiltered page.
  await page.getByRole("button", { name: "Clear person filter" }).click();
  await expect(page).not.toHaveURL(/person=/);
  await expect(page.getByLabel("Filter loans by person")).toHaveValue("");

  // Lending from the item page uses the same shared name input. Cancelling
  // must not create or remember the typed phantom name.
  await page.goto(`/items/${openItem.item.id}`);
  await page.getByRole("button", { name: "Lend" }).first().click();
  const lendBorrower = page.getByRole("combobox", { name: "Borrower" });
  await lendBorrower.fill("J");
  await expect(page.getByRole("option", { name: /Jack/ })).toBeVisible();
  await shot(page, "03-lend-autocomplete");
  await lendBorrower.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Jack/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await lendBorrower.press("Enter");
  await expect(lendBorrower).toHaveValue("Jack");

  await lendBorrower.fill("Zoe Cancelled");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const phantomLoans = await request.get("/api/v1/loans", {
    headers: await headers(request),
    params: { status: "all", person: "Zoe Cancelled" },
  });
  expect(phantomLoans.ok()).toBeTruthy();
  expect(((await phantomLoans.json()) as { total: number }).total).toBe(0);
  const phantomSuggestions = await request.get("/api/v1/loans/people", {
    headers: await headers(request),
    params: { q: "Zoe" },
  });
  expect(
    ((await phantomSuggestions.json()) as { items: Array<{ name: string }> }).items,
  ).toEqual([]);

  // Directly typed new names are saved only with the borrowed record.
  await page.goto("/loans");
  await page.getByRole("button", { name: "New loan" }).click();
  await page.getByRole("button", { name: /Borrow from someone/ }).click();
  await page.getByLabel("Item name").fill("Borrowed Zoe meter");
  const ownerInput = page.getByRole("combobox", { name: "Owner display name" });
  await ownerInput.fill("Zoe New");
  await page.getByRole("button", { name: "Record borrowed item" }).click();
  await expect(page.getByRole("heading", { name: "Borrow from someone" })).toBeHidden();

  const savedZoe = await request.get("/api/v1/borrowed", {
    headers: await headers(request),
    params: { status: "all", person: "Zoe New" },
  });
  expect(savedZoe.ok()).toBeTruthy();
  expect(((await savedZoe.json()) as { total: number }).total).toBe(1);

  await page.getByRole("button", { name: "New loan" }).click();
  await page.getByRole("button", { name: /Borrow from someone/ }).click();
  const ownerAgain = page.getByRole("combobox", { name: "Owner display name" });
  await ownerAgain.fill("Zo");
  await expect(page.getByRole("option", { name: /Zoe New/ })).toContainText(
    "1 borrowed",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Correcting one contract's name never renames the other Jamie contract.
  await page.goto(`/loans/${jamieFirst.id}`);
  await page.getByRole("button", { name: "Correct" }).click();
  const correctionBorrower = page.getByRole("combobox", { name: "Borrower" });
  await correctionBorrower.fill("Jamie");
  await expect(page.getByRole("option", { name: /Jamie/ }).first()).toBeVisible();
  await shot(page, "04-loan-name-correction");
  await correctionBorrower.fill("Jamie Chen");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByRole("heading", { name: "Jamie Chen" }),
  ).toBeVisible();

  const corrected = await request.get(`/api/v1/loans/${jamieFirst.id}`, {
    headers: await headers(request),
  });
  expect(((await corrected.json()) as LoanRecord).borrower_name).toBe(
    "Jamie Chen",
  );
  const untouched = await request.get(`/api/v1/loans/${jamieSecond.id}`, {
    headers: await headers(request),
  });
  const untouchedBody = (await untouched.json()) as LoanRecord & {
    history: Array<{ action: string }>;
  };
  expect(untouchedBody.borrower_name).toBe("Jamie");
  const jamieSuggestions = await request.get("/api/v1/loans/people", {
    headers: await headers(request),
    params: { q: "Jamie" },
  });
  expect(
    ((await jamieSuggestions.json()) as { items: Array<{ name: string }> }).items
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["Jamie", "Jamie Chen"]);
  const untouchedHistory = untouchedBody.history;
  expect(
    untouchedHistory.some((event) => event.action === "loan.corrected"),
  ).toBe(false);

  // Mobile layout, keyboard selection and no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/loans?person=Jack");
  await expect(page.getByLabel("Filter loans by person")).toHaveValue("Jack");
  await expect(page.getByText("to Jack")).toBeVisible();
  const mobileFilter = page.getByLabel("Filter loans by person");
  await mobileFilter.fill("");
  await mobileFilter.fill("J");
  await expect(page.getByRole("option", { name: /Jack/ })).toBeVisible();
  await mobileFilter.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Jack/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await mobileFilter.press("Enter");
  await expect(mobileFilter).toHaveValue("Jack");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await mobileFilter.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 220));
  await expect(page.getByText("to Jack")).toBeVisible();
  await shot(page, "05-loans-mobile-person");

  // Direction ownership remains correct after all filters.
  expect(jackOpen.outstanding_quantity).toBe(2);
  expect(jackBorrowed.owner_name).toBe("Jack");
  const returnedAgain = await request.get(
    `/api/v1/borrowed/${jackBorrowedReturned.id}`,
    { headers: await headers(request) },
  );
  expect(((await returnedAgain.json()) as BorrowedRecord).status).toBe(
    "returned",
  );
});

test("returned person filters survive detail links, browser Back and composed tabs", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 1100 });

  const room = await createRoom(request, "Filter origin E2E");
  const heavyDrill = await createItem(request, "Heavy drill", room.id);
  const sander = await createItem(request, "Cordless sander", room.id);
  const returnedLoan = await createLoan(
    request,
    heavyDrill.item.id,
    "Mohsen",
  );
  await returnLoan(request, returnedLoan.id);
  await createLoan(request, sander.item.id, "Mohsen");
  await createBorrowed(request, "Borrowed sander", "Mohsen");
  const returnedBorrowed = await createBorrowed(
    request,
    "Returned hose",
    "Mohsen",
  );
  await returnBorrowed(request, returnedBorrowed.id);

  await page.goto("/loans?person=Mohsen&status=returned");
  await expect(page).toHaveURL(/person=Mohsen/);
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  const filterTabs = page.getByRole("tablist", { name: "Loan filters" });
  await expect(
    filterTabs.getByRole("tab", { name: "Returned" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    filterTabs.getByRole("tab", { name: "Outstanding" }),
  ).toHaveAttribute("aria-selected", "false");
  await expect(page.getByLabel("Filter loans by person")).toHaveValue(
    "Mohsen",
  );
  await expect(page.getByText("Heavy drill")).toBeVisible();
  await expect(page.getByText("Returned hose")).toBeVisible();

  // Browser Back from a lent-out detail restores the returned person view.
  await page
    .getByTestId("loan-row")
    .filter({ hasText: "Heavy drill" })
    .getByRole("link", { name: "View details" })
    .click();
  await expect(page.getByRole("heading", { name: "Mohsen" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/person=Mohsen/);
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(
    filterTabs.getByRole("tab", { name: "Returned" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Heavy drill")).toBeVisible();
  await shot(page, "06-loans-returned-origin");

  // The explicit All loans back link preserves the same composed origin.
  await page
    .getByTestId("loan-row")
    .filter({ hasText: "Heavy drill" })
    .getByRole("link", { name: "View details" })
    .click();
  await page.getByRole("link", { name: "All loans" }).click();
  await expect(page).toHaveURL(/person=Mohsen/);
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(
    filterTabs.getByRole("tab", { name: "Returned" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Heavy drill")).toBeVisible();

  // Borrowed direction and its detail link keep person + returned status.
  await page
    .getByRole("tablist", { name: "Loan direction" })
    .getByRole("tab", { name: "Borrowed" })
    .click();
  await expect(page).toHaveURL(/direction=borrowed/);
  expect(new URL(page.url()).searchParams.get("person")).toBe("Mohsen");
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(page.getByText("Returned hose")).toBeVisible();
  await page
    .getByTestId("borrowed-row")
    .filter({ hasText: "Returned hose" })
    .getByRole("link", { name: "View details" })
    .click();
  await page.goBack();
  await expect(page).toHaveURL(/direction=borrowed/);
  expect(new URL(page.url()).searchParams.get("person")).toBe("Mohsen");
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(page.getByText("Returned hose")).toBeVisible();

  await page
    .getByTestId("borrowed-row")
    .filter({ hasText: "Returned hose" })
    .getByRole("link", { name: "View details" })
    .click();
  await page.getByRole("link", { name: "All loans" }).click();
  await expect(page).toHaveURL(/direction=borrowed/);
  expect(new URL(page.url()).searchParams.get("person")).toBe("Mohsen");
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(page.getByText("Returned hose")).toBeVisible();

  // All-direction tab keeps the person and status; text, overdue and direction
  // filters compose together without clearing each other.
  await page
    .getByRole("tablist", { name: "Loan direction" })
    .getByRole("tab", { name: "All" })
    .click();
  expect(new URL(page.url()).searchParams.has("direction")).toBe(false);
  expect(new URL(page.url()).searchParams.get("person")).toBe("Mohsen");
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");

  await page.goto(
    "/loans?person=Mohsen&status=open&overdue=1&direction=all&q=sander",
  );
  await expect(
    filterTabs.getByRole("tab", { name: "Outstanding" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Past due only")).toBeChecked();
  await expect(page.getByLabel("Search loans")).toHaveValue("sander");
  await expect(page.getByLabel("Filter loans by person")).toHaveValue(
    "Mohsen",
  );
  await expect(page.getByText("Cordless sander")).toBeVisible();
  await expect(page.getByText("Borrowed sander")).toBeVisible();

  await page
    .getByRole("tablist", { name: "Loan direction" })
    .getByRole("tab", { name: "Lent out" })
    .click();
  expect(new URL(page.url()).searchParams.get("direction")).toBe("lent_out");
  expect(new URL(page.url()).searchParams.get("person")).toBe("Mohsen");
  expect(new URL(page.url()).searchParams.get("status")).toBe("open");
  expect(new URL(page.url()).searchParams.get("overdue")).toBe("1");
  expect(new URL(page.url()).searchParams.get("q")).toBe("sander");
  await expect(page.getByText("Cordless sander")).toBeVisible();
  await expect(page.getByText("Borrowed sander")).not.toBeVisible();
  await shot(page, "07-loans-composed-filters");

  await page
    .getByRole("tablist", { name: "Loan direction" })
    .getByRole("tab", { name: "Borrowed" })
    .click();
  expect(new URL(page.url()).searchParams.get("direction")).toBe("borrowed");
  await expect(page.getByText("Borrowed sander")).toBeVisible();
  await expect(page.getByText("Cordless sander")).not.toBeVisible();

  // Default entry stays clean; item scope still works as a deep link.
  await page.goto("/loans");
  expect(new URL(page.url()).search).toBe("");
  await expect(
    filterTabs.getByRole("tab", { name: "Outstanding" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto(`/loans?item_id=${heavyDrill.item.id}&status=returned`);
  expect(new URL(page.url()).searchParams.get("item_id")).toBe(
    heavyDrill.item.id,
  );
  expect(new URL(page.url()).searchParams.get("status")).toBe("returned");
  await expect(
    page.getByText(/Showing loans for one owned item/),
  ).toBeVisible();
  await expect(page.getByText("Heavy drill")).toBeVisible();
});
