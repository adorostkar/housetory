import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8090";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    storageState: "./e2e/.auth/state.json",
    channel: process.env.E2E_CHANNEL ?? "chrome",
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS === "true",
    launchOptions:
      process.env.E2E_IGNORE_HTTPS === "true"
        ? { args: ["--ignore-certificate-errors"] }
        : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
