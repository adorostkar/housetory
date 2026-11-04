import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? process.env.E2E_BASE_URL;
  const email = process.env.E2E_EMAIL ?? "phase5@example.com";
  const password = process.env.E2E_PASSWORD ?? "phase-five-password-2026";
  const context = await request.newContext({
    baseURL,
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS === "true",
  });
  const sessionResponse = await context.get("/api/v1/auth/session");
  const session = await sessionResponse.json();
  let response;
  if (session.setup_required) {
    response = await context.post("/api/v1/auth/setup", {
      data: {
        name: "Phase Five Owner",
        email,
        password,
        household_name: "Housetory Phase Five",
      },
    });
  } else {
    response = await context.post("/api/v1/auth/login", { data: { email, password } });
  }
  if (!response.ok()) {
    throw new Error(
      `E2E authentication failed (${response.status()}). ` +
        "Use a disposable stack and set E2E_EMAIL/E2E_PASSWORD.",
    );
  }
  const authDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".auth");
  fs.mkdirSync(authDir, { recursive: true });
  await context.storageState({ path: path.join(authDir, "state.json") });
  await context.dispose();
}
