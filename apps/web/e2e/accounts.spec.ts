import { expect, test } from "@playwright/test";

test("separates account settings from household member administration", async ({ page }) => {
  await page.goto("/settings/account");
  await expect(
    page.getByRole("heading", { name: "Your account", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeVisible();
  await expect(page.getByText("Household role")).toBeVisible();

  await page.goto("/settings/members");
  await expect(
    page.getByRole("heading", { name: "Members & invitations", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Phase Five Owner").first()).toBeVisible();
  await expect(page.getByText("Owner").first()).toBeVisible();
  await expect(
    page.getByText(/Email delivery is not configured/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite person" })).toBeDisabled();
});

test("shows generic recovery messaging and useful invalid-link states", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(
    page.getByText(/If an account exists for that email/i),
  ).toBeVisible();

  await page.goto("/reset-password/not-a-real-reset-token");
  await expect(
    page.getByRole("heading", { name: "Reset link unavailable." }),
  ).toBeVisible();

  await page.goto("/invitations/not-a-real-invitation-token");
  await expect(
    page.getByRole("heading", { name: "Invitation unavailable." }),
  ).toBeVisible();
});

test("renders the new-account invitation form for a valid token", async ({ page }) => {
  const token = "demo-invitation-token";
  await page.route(`**/api/v1/invitations/${token}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        household_name: "Mock Household",
        email: "invited@example.com",
        role: "member",
        expires_at: "2026-12-01T00:00:00Z",
        account_exists: false,
        authenticated_email_matches: false,
      }),
    });
  });
  await page.route(`**/api/v1/invitations/${token}/accept`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        setup_required: false,
        user: {
          id: "demo-user",
          name: "Invited Person",
          email: "invited@example.com",
          created_at: "2026-01-01T00:00:00Z",
        },
        household: {
          id: "demo-household",
          name: "Mock Household",
          warranty_reminder_days: 30,
        },
        role: "member",
      }),
    });
  });

  await page.context().clearCookies();
  await page.goto(`/invitations/${token}`);
  await expect(
    page.getByRole("heading", { name: "You’re invited." }),
  ).toBeVisible();
  await expect(page.getByText("Mock Household")).toBeVisible();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await expect(page.getByLabel("Choose a password")).toBeVisible();
  await expect(page.getByLabel("Confirm password")).toBeVisible();
});
