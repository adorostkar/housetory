import http from "node:http";

import { expect, test, type APIRequestContext } from "@playwright/test";

const BRAVE_FIXTURE_PORT = 4789;
const BRAVE_FIXTURE_KEY = "e2e-fixture-key";
let braveServer: http.Server | undefined;
const braveRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

test.beforeAll(async () => {
  braveServer = http.createServer((request, response) => {
    if (request.url?.startsWith("/res/v1/web/search")) {
      braveRequests.push({
        url: request.url,
        headers: request.headers,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "search",
          query: { original: "manual", more_results_available: false },
          web: {
            type: "search",
            results: [
              {
                title: "DeWalt DCD791B 20V MAX Drill Instruction Manual",
                url: "https://www.dewalt.com/-/media/manuals/DCD791B.pdf",
                description:
                  "Official DCD791B instruction manual covering safety, battery and chuck operation.",
                extra_snippets: [
                  "Disconnect the battery before changing the drill bit or servicing the tool.",
                ],
                profile: { name: "DeWalt", long_name: "DeWalt" },
                language: "en",
              },
              {
                title: "DeWalt DCD790 Drill Manual",
                url: "https://manualslib.example/DCD790",
                description: "A similar drill manual.",
                profile: { name: "ManualsLib", long_name: "ManualsLib" },
              },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    braveServer?.once("error", reject);
    braveServer?.listen(BRAVE_FIXTURE_PORT, "0.0.0.0", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    braveServer?.close(() => resolve());
  });
});

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/items", {
    data: { name, brand: "DeWalt", model: "DCD791" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("uploads a manual without make/model, keeps its page text, and attaches it to another item", async ({
  page,
  request,
}) => {
  const id = suffix();
  const title = `Drill manual ${id}`;
  const first = await createItem(request, `Drill one ${id}`);
  const second = await createItem(request, `Drill two ${id}`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  // Documents and manuals have their own tab on the item page.
  await page.goto(`/items/${first.item.id}?tab=documents`);
  await page.getByRole("button", { name: "Add manual" }).first().click();
  const uploadDialog = page.getByRole("dialog", { name: "Add a manual" });
  await expect(uploadDialog).toBeVisible();
  await expect(uploadDialog.getByLabel("Type")).toHaveCount(0);
  await uploadDialog.getByTestId("document-file").setInputFiles({
    name: "drill-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Safety\nDisconnect the battery before changing the drill bit.\n\n" +
        "Maintenance\nApply light machine oil to the chuck monthly.",
    ),
  });
  // The manual is saved at once. The title is an optional detail after that.
  await uploadDialog.getByRole("button", { name: /Add details/ }).click();
  await uploadDialog.getByLabel("Title").fill(title);
  await uploadDialog.getByRole("button", { name: "Save details" }).click();
  await uploadDialog.getByRole("button", { name: "Done" }).click();
  await expect(uploadDialog).toBeHidden();
  await expect(page.getByText(title).first()).toBeVisible();

  await expect
    .poll(
      async () => {
        const listing = await request.get(`/api/v1/items/${first.item.id}/manuals`);
        const data = (await listing.json()) as {
          manuals: Array<{ title: string; id: string; ocr_status: string }>;
        };
        return data.manuals.find((manual) => manual.title === title)?.ocr_status;
      },
      { timeout: 60_000 },
    )
    .toBe("succeeded");

  await page.reload();
  await expect(page.getByText(title).first()).toBeVisible();
  // The text is stored with the document, page by page, and needs no AI to be read.
  const listed = (await (await request.get(`/api/v1/items/${first.item.id}/manuals`)).json()) as {
    manuals: Array<{ title: string; id: string }>;
  };
  const manualId = listed.manuals.find((manual) => manual.title === title)!.id;
  await expect
    .poll(async () => {
      const text = (await (await request.get(`/api/v1/documents/${manualId}/text`)).json()) as {
        pages: Array<{ text: string }>;
      };
      return text.pages.map((entry) => entry.text).join("\n");
    }, { timeout: 60_000 })
    .toContain("Disconnect the battery before changing the drill bit.");
  // Questions about a manual go to the assistant: the item has no question dialog of its own.
  await expect(page.getByRole("button", { name: "Ask about this item" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask attached manuals" })).toHaveCount(0);

  await page.goto(`/items/${second.item.id}?tab=documents`);
  await page.getByRole("button", { name: "Link existing" }).click();
  const attachDialog = page.getByRole("dialog", { name: "Link an existing document" });
  const row = attachDialog.locator("li").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Link" }).click();
  await expect(attachDialog).toBeHidden();
  await expect(page.getByText(title).first()).toBeVisible();
});

test("discovers through the concrete Brave adapter, reviews the real source and saves a readable manual", async ({
  page,
  request,
}) => {
  const id = suffix();
  const item = await createItem(request, `Brave drill ${id}`);
  await page.setViewportSize({ width: 390, height: 844 });

  const configure = await request.put("/api/v1/settings/online-search", {
    data: { manual_enabled: true, api_key: BRAVE_FIXTURE_KEY },
  });
  expect(configure.ok()).toBeTruthy();
  const initial = await request.get(`/api/v1/items/${item.item.id}/manuals`);
  const status = (await initial.json()) as {
    search: { provider: string | null; provider_label: string | null };
  };
  test.skip(
    status.search.provider !== "brave",
    "Brave fixture not configured; start the disposable stack with BRAVE_SEARCH_PROVIDER=brave and fixture key/base URL.",
  );

  const profile = await request.put(`/api/v1/items/${item.item.id}/manual-profile`, {
    data: {
      manufacturer: "DeWalt",
      model_identifier: "DCD791",
      variant: "B",
      confirmed: true,
    },
  });
  expect(profile.ok()).toBeTruthy();

  const savedTitle = `Saved manual ${id}`;
  const upload = await request.post("/api/v1/documents", {
    multipart: {
      file: {
        name: "saved-manual.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "Safety\nDisconnect the battery before changing the drill bit.\n\n" +
            "Maintenance\nApply light machine oil to the chuck monthly.",
        ),
      },
      title: savedTitle,
      document_type: "manual",
    },
  });
  expect(upload.ok()).toBeTruthy();
  const savedDocument = (await upload.json()) as {
    id: string;
    title: string;
    ocr_status: string;
  };
  await expect
    .poll(
      async () => {
        const current = await request.get(`/api/v1/documents/${savedDocument.id}`);
        return ((await current.json()) as { ocr_status: string }).ocr_status;
      },
      { timeout: 60_000 },
    )
    .toBe("succeeded");

  await page.route(
    `**/api/v1/items/${item.item.id}/manual-search/*/download`,
    async (route) => {
      const attach = await request.post(
        `/api/v1/items/${item.item.id}/manuals/${savedDocument.id}`,
      );
      expect(attach.ok()).toBeTruthy();
      const document = await (
        await request.get(`/api/v1/documents/${savedDocument.id}`)
      ).json();
      const candidateList = await (
        await request.get(`/api/v1/items/${item.item.id}/manual-search`)
      ).json();
      const candidate = candidateList.candidates.find(
        (entry: { file_url: string }) => entry.file_url.endsWith("DCD791B.pdf"),
      );
      await route.fulfill({
        json: {
          document,
          candidate: { ...candidate, document_id: savedDocument.id, direct_file: true },
          duplicate_documents: [],
        },
      });
    },
  );

  await page.goto(`/items/${item.item.id}?tab=documents`);
  await page.getByRole("button", { name: "Find manual" }).click();
  const dialog = page.getByRole("dialog", { name: `Find a manual for ${item.item.name}` });
  await expect(dialog.getByText("Brave Search API")).toBeVisible();
  await dialog.getByRole("button", { name: "Search for exact model" }).click();
  await expect(
    dialog.getByText("DeWalt DCD791B 20V MAX Drill Instruction Manual"),
  ).toBeVisible();
  await expect(dialog.getByText("Manufacturer", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review & download" }).click();
  await expect(dialog.getByText(/I reviewed this candidate and verified/)).toBeVisible();
  const confirmDownload = dialog.getByRole("button", { name: /Download & attach/ });
  await expect(confirmDownload).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await confirmDownload.click();
  await expect(page.getByText("Manual saved and attached")).toBeVisible();

  expect(braveRequests.length).toBeGreaterThan(0);
  const requestQuery = new URL(
    `http://fixture${braveRequests[0]?.url ?? "/"}`,
  ).searchParams.get("q");
  expect(braveRequests[0]?.headers["x-subscription-token"]).toBe(BRAVE_FIXTURE_KEY);
  expect(requestQuery).toContain("DeWalt");
  expect(requestQuery).toContain("DCD791");
  expect(requestQuery).toContain("B");
  expect(requestQuery?.toLowerCase()).not.toContain("borrower");
  expect(requestQuery?.toLowerCase()).not.toContain("household");
  expect(requestQuery?.toLowerCase()).not.toContain("loan");

  await page.keyboard.press("Escape");
  // The saved manual is read like an uploaded one. Questions go to the assistant: there
  // is no separate online question dialog.
  const saved = (await (await request.get(`/api/v1/items/${item.item.id}/manuals`)).json()) as {
    manuals: Array<{ title: string; id: string }>;
  };
  const savedId = saved.manuals.find((manual) => manual.title === savedTitle)!.id;
  await expect
    .poll(async () => {
      const text = (await (await request.get(`/api/v1/documents/${savedId}/text`)).json()) as {
        pages: Array<{ text: string }>;
      };
      return text.pages.map((entry) => entry.text).join("\n");
    }, { timeout: 60_000 })
    .toContain("Disconnect the battery before changing the drill bit.");
  await expect(page.getByRole("button", { name: "Ask online sources" })).toHaveCount(0);
});

interface AssistantStep {
  call: { name: string; arguments: Record<string, string> };
  result: {
    references?: { id: string }[];
    facts?: { pages?: { document_id: string; document: string; page: number; text: string }[] };
  };
}

test("the assistant finds a manual online, shows each proposal only when it has finished, and answers from the saved file", async ({
  page,
  request,
}) => {
  test.skip(!process.env.TOOLS_E2E_ISOLATED, "Requires a disposable API/database and a real worker");
  const id = suffix();
  const name = `Assistant drill ${id}`;
  const created = await request.post("/api/v1/items", {
    data: { name, brand: "DeWalt", model: "DCD791B" },
  });
  expect(created.ok()).toBeTruthy();
  const itemId = ((await created.json()) as { item: { id: string } }).item.id;
  const configure = await request.put("/api/v1/settings/online-search", {
    data: { manual_enabled: true, api_key: BRAVE_FIXTURE_KEY },
  });
  expect(configure.ok()).toBeTruthy();

  // A scripted model: it chooses the tools a real one would, and is slow with its last
  // word after a proposal was prepared, so the time in between can be seen.
  const tool = (call: string, args: object) => ({ kind: "tool", call: { name: call, arguments: args } });
  const model = http.createServer(async (incoming, response) => {
    response.setHeader("Content-Type", "application/json");
    if (incoming.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "online-manual-test" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const messages = JSON.parse(Buffer.concat(chunks).toString()).messages as { content: string }[];
    const prompt = messages.at(-1)!.content;
    let output: unknown = { sections: [], topics: [] };
    if (prompt.includes('"step_schema"')) {
      const input = JSON.parse(prompt) as { request: string; observations: AssistantStep[] };
      const observed = input.observations;
      const last = observed.at(-1);
      if (input.request !== "Continue." && observed.length === 0) {
        output = tool("search_items", { q: name });
      } else if (input.request !== "Continue." && observed.length === 1) {
        output = tool("find_manuals_online", { item_id: last!.result.references![0]!.id });
      } else if (last?.call.name === "find_manuals_online") {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        output = { kind: "answer", message: "Please check the card." };
      } else if (!last) {
        output = tool("read_manual", { item_id: itemId });
      } else {
        const read = last.result.facts!.pages![0]!;
        const quote = read.text.trim().split("\n")[1]!;
        output = {
          kind: "answer",
          message: `${quote} (${read.document}, page ${read.page}).`,
          sources: [{ document_id: read.document_id, pages: [read.page], quote }],
        };
      }
    }
    response.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(output) } }));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const provider = await request.post("/api/v1/ai/providers", {
    data: {
      provider: "ollama",
      display_name: `Scripted online manual model ${id}`,
      base_url: `http://127.0.0.1:${(model.address() as { port: number }).port}`,
      default_model: "online-manual-test",
      enabled: true,
    },
  });
  expect(provider.ok(), await provider.text()).toBeTruthy();
  const providerId = ((await provider.json()) as { id: string }).id;
  try {
    const task = await request.put("/api/v1/ai/tasks/assistant", {
      data: { provider_id: providerId, model: "online-manual-test", enabled: true },
    });
    expect(task.ok(), await task.text()).toBeTruthy();

    // The file the save leads to. The server cannot fetch from a test fixture, so the
    // download itself is stood in for below, as in the test above.
    const savedTitle = `Assistant manual ${id}`;
    const upload = await request.post("/api/v1/documents", {
      multipart: {
        file: {
          name: "assistant-manual.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Changing the bit\nDisconnect the battery before changing the drill bit."),
        },
        title: savedTitle,
        document_type: "manual",
      },
    });
    expect(upload.ok()).toBeTruthy();
    const savedId = ((await upload.json()) as { id: string }).id;
    await expect
      .poll(async () => {
        const text = (await (await request.get(`/api/v1/documents/${savedId}/text`)).json()) as {
          pages_read: number;
          reading: boolean;
        };
        return text.pages_read > 0 && !text.reading;
      }, { timeout: 60_000 })
      .toBe(true);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/items");
    const searchesBefore = braveRequests.length;
    const search = page.getByRole("combobox", { name: "Search or ask about your inventory" });
    await search.fill(`How do I change the bit on ${name}?`);
    await search.press("Enter");

    // The brand and model recorded on the item are enough: nothing is asked before the
    // search. It leads to one manual to save. The proposal is prepared while the
    // assistant still works: the page says so, and shows the card when it has finished.
    // Earlier conversations of this household stay on the page: only this item's cards count.
    const cards = page.getByLabel("Action review").filter({ hasText: name });
    const working = page.getByRole("status").filter({ hasText: "A proposal is prepared." });
    await expect(working).toContainText(
      "A proposal is prepared. It appears for your review when the assistant has finished.",
    );
    await expect(cards).toHaveCount(0);
    await expect(cards).toHaveCount(1);
    await expect(working).toHaveCount(0);
    expect(braveRequests.length).toBeGreaterThan(searchesBefore);
    const save = cards.last();
    await expect(save).toContainText("Check that this manual is for your exact model");
    await expect(
      save.getByRole("link", { name: "https://www.dewalt.com/-/media/manuals/DCD791B.pdf" }).first(),
    ).toBeVisible();
    // The page the manual was found on is in the closed Sources list under the answer.
    await page.getByLabel("Assistant tool task").last().getByText(/^Sources \(\d+\)$/).click();
    await expect(
      page.getByLabel("Online sources").last().getByRole("link", {
        name: "DeWalt DCD791B 20V MAX Drill Instruction Manual",
      }),
    ).toBeVisible();

    await page.route("**/api/v1/assistant/actions/proposals/*/apply", async (route) => {
      const attach = await request.post(`/api/v1/items/${itemId}/manuals/${savedId}`);
      expect(attach.ok()).toBeTruthy();
      await route.fulfill({ json: { message: "Saved the manual." } });
    });
    await save.getByRole("button", { name: "Apply" }).click();
    await expect(save.getByText("Saved the manual.")).toBeVisible();

    // The conversation goes on by itself and answers from the saved file, with its page.
    const answered = page.getByLabel("Assistant tool task").last();
    await expect(answered.getByTestId("answer-text")).toContainText(
      `Disconnect the battery before changing the drill bit. (${savedTitle}, page 1)`,
      { timeout: 60_000 },
    );
    // The page it quotes is in the closed Sources list of this answer.
    await answered.getByText(/^Sources \(\d+\)$/).click();
    await expect(
      answered
        .getByRole("list", { name: "Manual citations" })
        .getByRole("link", { name: `${savedTitle}, page 1`, exact: true }),
    ).toHaveAttribute("href", new RegExp(`^/documents/${savedId}/view\\?page=1(&|$)`));
    // Reading a manual opened no capture or extraction review.
    await expect(page.getByLabel("Assistant capture status")).toHaveCount(0);
    await expect(page.getByLabel("Assistant document review")).toHaveCount(0);
  } finally {
    await request.delete(`/api/v1/ai/providers/${providerId}`);
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});
