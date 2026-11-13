import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "invoice-stage-a.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8097",
    channel: "chrome",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8097",
    url: "http://127.0.0.1:8097",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
