import { defineConfig } from "@playwright/test";

const baseURL = process.env.STAGE_D_BASE_URL;
if (process.env.STAGE_D_ISOLATED !== "1" || !baseURL) {
  throw new Error("Set STAGE_D_ISOLATED=1 and STAGE_D_BASE_URL to a disposable local deployment.");
}
const url = new URL(baseURL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Stage D browser tests require a loopback deployment.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "assistant-stage-d-invoice.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL,
    channel: process.env.E2E_CHANNEL ?? "chrome",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});
