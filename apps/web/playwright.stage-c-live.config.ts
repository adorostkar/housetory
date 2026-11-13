import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "assistant-stage-c-live.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:18197",
    channel: "chrome",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "VITE_API_PROXY_TARGET=http://127.0.0.1:18198 npm run dev -- --host 127.0.0.1 --port 18197 --strictPort",
    url: "http://127.0.0.1:18197",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
