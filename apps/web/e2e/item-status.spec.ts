import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const photoPath = path.resolve(here, "../public/icons/icon-192.png");
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8090";
const ownerEmail = process.env.E2E_EMAIL ?? "e2e-owner@example.com";
const ownerPassword = process.env.E2E_PASSWORD ?? "e2e-owner-password-2026";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(
  request: APIRequestContext,
  name: string,
  payload: Record<string, unknown> = {},
) {
  const response = await request.post("/api/v1/items", {
    data: { name, ...payload },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(
  request: APIRequestContext,
  itemId: string,
  payload: Record<string, unknown>,
) {
  const response = await request.post("/api/v1/loans", {
    data: {
      item_id: itemId,
      lent_on: "2026-10-01",
      request_id: crypto.randomUUID(),
      ...payload,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; outstanding_quantity: number };
}

async function returnLoan(
  request: APIRequestContext,
  loanId: string,
  quantity: number,
) {
  const response = await request.post(`/api/v1/loans/${loanId}/returns`, {
    data: {
      quantity,
      returned_on: "2026-11-05",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function createFixture(
  request: APIRequestContext,
  label: string,
  quantity: number,
  loans: Array<Record<string, unknown>>,
  options: { photo?: boolean } = {},
) {
  const properties = (await (
    await request.get("/api/v1/properties")
  ).json()) as { items: Array<{ id: string }> };
  const room = (await (
    await request.post("/api/v1/rooms", {
      data: {
        name: `Status room ${label}`,
        property_id: properties.items[0]?.id,
      },
    })
  ).json()) as { id: string };
  const box = (await (
    await request.post("/api/v1/containers", {
      data: { room_id: room.id, container_type: "box", name: "Power tools" },
    })
  ).json()) as { id: string; identifier: string };
  const item = await createItem(request, `Item ${label}`, {
    quantity,
    room_id: room.id,
    storage_location_id: box.id,
  });
  for (const loan of loans) {
    await createLoan(request, item.item.id, loan);
  }
  if (options.photo) {
    const upload = await request.post(`/api/v1/items/${item.item.id}/photos`, {
      multipart: {
        files: {
          name: `photo-${label}.png`,
          mimeType: "image/png",
          buffer: fs.readFileSync(photoPath),
        },
      },
    });
    expect(upload.ok()).toBeTruthy();
  }
  return { item, room, box };
}

function createViewer(email: string) {
  const owner = ownerEmail.replaceAll("'", "''");
  const viewer = email.replaceAll("'", "''");
  const sql = `
    INSERT INTO users (id, name, email, password_hash)
    SELECT gen_random_uuid(), 'Status Viewer', '${viewer}', password_hash
    FROM users WHERE email = '${owner}';
    INSERT INTO household_members (household_id, user_id, role)
    SELECT (SELECT id FROM households ORDER BY created_at LIMIT 1), id, 'viewer'
    FROM users WHERE email = '${viewer}';
  `;
  execFileSync(
    "docker",
    [
      "exec",
      process.env.E2E_DB_CONTAINER ?? "housetory-e2e-db-1",
      "psql",
      "-U",
      "housetory",
      "-d",
      "housetory",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "pipe" },
  );
}

test("item title area states the full loan truth and labels the usual home", async ({
  page,
  request,
}) => {
  const id = suffix();
  const full = await createFixture(request, `full-${id}`, 1, [
    { borrower_name: "Mohsen", quantity: 1, notes: "PRIVATE BORROWER NOTE" },
  ]);
  const partial = await createFixture(request, `partial-${id}`, 3, [
    { borrower_name: "Mohsen", quantity: 1, due_on: "2026-11-20" },
  ]);
  const multiple = await createFixture(request, `multiple-${id}`, 3, [
    { borrower_name: "Mohsen", quantity: 1, due_on: "2026-11-20" },
    { borrower_name: "Alex", quantity: 1 },
  ]);

  await page.goto(`/items/${full.item.item.id}`);
  await expect(page.getByText("On loan to Mohsen")).toBeVisible();
  await expect(
    page.getByText(/Owned 1 · at home 0 · on loan 1 · No return date set/),
  ).toBeVisible();
  await expect(page.getByText(/No return date set/)).toBeVisible();
  await expect(page.getByText(/usual home, not a current physical location/)).toBeVisible();
  await expect(page.getByText("Usual home location")).toBeVisible();
  await expect(page.getByText(/PRIVATE BORROWER NOTE/)).toHaveCount(0);
  await expect(page.getByText("No photograph yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Take a photo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a photo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record return" })).toBeVisible();

  await page.goto(`/items/${partial.item.item.id}`);
  await expect(page.getByText("1 of 3 units on loan to Mohsen")).toBeVisible();
  await expect(
    page.getByText(/Owned 3 · at home 2 · on loan 1 · Due/),
  ).toBeVisible();
  await expect(page.getByText(/covers only the 2 at-home units/)).toBeVisible();
  await expect(page.getByText("Usual home location")).toBeVisible();

  await page.goto(`/items/${multiple.item.item.id}`);
  await expect(page.getByText("2 of 3 units on loan")).toBeVisible();
  await expect(page.getByText(/Mohsen · 1 of 1 on loan/)).toBeVisible();
  await expect(page.getByText(/Alex · 1 of 1 on loan/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record return from Mohsen" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record return from Alex" }),
  ).toBeVisible();
});

test("authorized return flow uses the selected loan and restores the at-home state", async ({
  page,
  request,
}) => {
  const id = suffix();
  const fixture = await createFixture(request, `return-${id}`, 1, [
    { borrower_name: "Mohsen", quantity: 1, due_on: "2026-11-20" },
  ]);
  await page.goto(`/items/${fixture.item.item.id}`);
  await expect(page.getByText("On loan to Mohsen")).toBeVisible();
  await page.getByRole("button", { name: "Record return" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Return from Mohsen" })).toBeVisible();
  await expect(dialog.getByLabel("Quantity")).toHaveValue("1");
  await dialog.getByRole("button", { name: "Record return" }).click();
  await expect(page.getByText("On loan to Mohsen")).toHaveCount(0);
  await expect(page.getByText(/Everything is at home/)).toBeVisible();
  await expect(page.getByText("Place", { exact: true })).toBeVisible();
  await expect(page.getByText("Usual home location")).toHaveCount(0);
});

test("returned loans and populated galleries render truthfully", async ({
  page,
  request,
}) => {
  const id = suffix();
  const returned = await createFixture(request, `returned-${id}`, 1, []);
  const loan = await createLoan(request, returned.item.item.id, {
    borrower_name: "Mohsen",
    quantity: 1,
  });
  await returnLoan(request, loan.id, 1);
  const gallery = await createFixture(request, `gallery-${id}`, 1, [], {
    photo: true,
  });

  await page.goto(`/items/${returned.item.item.id}`);
  await expect(page.getByText(/Everything is at home/)).toBeVisible();
  await expect(page.getByText("Usual home location")).toHaveCount(0);
  await expect(page.getByText("Place", { exact: true })).toBeVisible();
  await expect(page.getByText("On loan to Mohsen")).toHaveCount(0);

  await page.goto(`/items/${gallery.item.item.id}`);
  await expect(page.getByText("No photograph yet")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: new RegExp(`${gallery.item.item.name} photograph`) }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose a photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Take photo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose photo" })).toHaveCount(0);
});

test("viewers see loan state but no return or editing actions", async ({
  browser,
  request,
}) => {
  const id = suffix();
  const fixture = await createFixture(request, `viewer-${id}`, 1, [
    { borrower_name: "Mohsen", quantity: 1 },
  ]);
  const viewerEmail = `status-viewer-${id}@example.com`;
  createViewer(viewerEmail);

  const viewerRequest = await playwrightRequest.newContext({ baseURL });
  const login = await viewerRequest.post("/api/v1/auth/login", {
    data: { email: viewerEmail, password: ownerPassword },
  });
  expect(login.ok()).toBeTruthy();
  const context = await browser.newContext({
    baseURL,
    storageState: await viewerRequest.storageState(),
  });
  await viewerRequest.dispose();
  const page = await context.newPage();
  await page.goto(`/items/${fixture.item.item.id}`);
  await expect(page.getByText("On loan to Mohsen")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record return" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Lend" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);

  await page.goto("/loans");
  await expect(page.getByRole("heading", { name: "Loans" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New loan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record return" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View details" }).first()).toBeVisible();
  await context.close();
});
