import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";

test.skip(!process.env.TOOLS_E2E_ISOLATED, "Requires a disposable API/database and a real worker");

const TITLE = "ASIM6K0R-EN-v2";
const PAGES = [
  ["ASIM6K0R DIGITAL MULTIMETER", "User manual. Read the safety notes first."],
  [
    "CURRENT MEASUREMENT",
    "To measure current (amperage) up to 10 A, turn the rotary dial to 10A",
    "and move the red lead to the 10A jack.",
  ],
  ["BATTERY REPLACEMENT", "Open the rear cover and replace the 9 V battery."],
];

interface Step {
  call: { name: string; arguments: Record<string, string> };
  result: {
    references?: { id: string; type: string }[];
    facts?: {
      manuals?: { title: string }[];
      pages?: { document_id: string; document: string; page: number; text: string }[];
      map?: { document_id: string; topics: { topic: string; pages: string }[] }[];
    };
  };
}

let server: Server;
let providerId = "";
let itemName = "";
let mapsBuilt = 0;

/** A small text PDF, so stored page numbers are real. */
function manualPdf(pages: string[][]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, index) => {
    const text = lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ");
    const content = `BT /F1 12 Tf 16 TL 72 720 Td ${text} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test.beforeAll(async ({ request }) => {
  expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "manual-browser-test" }] }));
      return;
    }
    if (req.url !== "/api/chat") { res.writeHead(404).end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const messages = JSON.parse(Buffer.concat(chunks).toString()).messages as { content: string }[];
    const prompt = messages.at(-1)!.content;
    let output: unknown = {};
    if (messages[0]!.content.includes("You index a document")) {
      // The map: one topic per page, named by the heading the page starts with.
      const topics = prompt.split("[page ").slice(1).map((block) => ({
        topic: block.split("\n")[1]!.toLowerCase(), pages: [Number.parseInt(block, 10)],
      }));
      output = { sections: [], topics };
      mapsBuilt += 1;
    } else if (prompt.includes('"step_schema"')) {
      const input = JSON.parse(prompt) as {
        request: string; observations: Step[]; context_newest_first: { observations: Step[] }[];
      };
      const observed = input.observations;
      const tool = (name: string, args: object) => ({ kind: "tool", call: { name, arguments: args } });
      if (input.request.startsWith("Show me")) {
        output = observed.length === 0 ? tool("search_items", { q: itemName })
          : observed.length === 1
            ? tool("find_manuals", { item_id: observed[0]!.result.references![0]!.id })
            : { kind: "answer", message: `Your multimeter's manual is **${observed[1]!.result.facts!.manuals![0]!.title}**.` };
      } else if (observed.length === 0) {
        // Follow-ups can only use what earlier turns left in the conversation context.
        const earlier = input.context_newest_first.flatMap((turn) => turn.observations);
        if (input.request.includes("battery")) {
          // The last turn left the map and no page text: only the page needed is read.
          const map = earlier.flatMap((step) => step.result.facts?.map ?? [])[0]!;
          output = tool("read_manual", {
            document_id: map.document_id,
            pages: map.topics.find((entry) => entry.topic.includes("battery"))!.pages,
          });
        } else {
          output = tool("read_manual", {
            item_id: earlier.find((step) => step.call.name === "find_manuals")!.call.arguments.item_id,
          });
        }
      } else {
        const heading = input.request.includes("battery") ? "BATTERY REPLACEMENT" : "CURRENT MEASUREMENT";
        const read = observed[0]!.result.facts!.pages!.find((entry) => entry.text.startsWith(heading))!;
        const lines = read.text.trim().split("\n").slice(1);
        output = {
          kind: "answer",
          message: `${lines.join(" ")} (${read.document}, page ${read.page}).`,
          sources: [{ document_id: read.document_id, pages: [read.page], quote: lines[0] }],
        };
      }
    }
    res.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(output) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port");
  const provider = await request.post("/api/v1/ai/providers", { data: {
    provider: "ollama", display_name: "Synthetic manual browser provider",
    base_url: `http://127.0.0.1:${address.port}`, default_model: "manual-browser-test", enabled: true,
  } });
  expect(provider.ok(), await provider.text()).toBeTruthy();
  providerId = (await provider.json()).id;
  const task = await request.put("/api/v1/ai/tasks/assistant", { data: {
    provider_id: providerId, model: "manual-browser-test", enabled: true,
  } });
  expect(task.ok(), await task.text()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  if (providerId) await request.delete(`/api/v1/ai/providers/${providerId}`);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(page: Page, text: string, header = false) {
  const input = header
    ? page.getByRole("combobox", { name: "Search or ask about your inventory" })
    : page.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill(text);
  if (header) await input.press("Enter");
  else {
    const send = page.getByRole("button", { name: "Send question", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
  }
}

/**
 * The share of dark pixels on a page canvas. A drawn page of text is mostly
 * white with some ink; a blank canvas has none and an unpainted one is all dark.
 */
function ink(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.width || !element.height) return 0;
    const { data } = element.getContext("2d")!.getImageData(0, 0, element.width, element.height);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index]! < 200) dark += 1;
    return dark / (data.length / 4);
  });
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} attached manual is opened as the file itself and answered with page citations`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    itemName = `Manual multimeter ${crypto.randomUUID().slice(0, 7)}`;
    const item = (await (await request.post("/api/v1/items", { data: { name: itemName } })).json()).item;
    const pdf = manualPdf(PAGES);
    const mapsBefore = mapsBuilt;
    const upload = await request.post("/api/v1/documents", { multipart: {
      file: { name: `${TITLE}.pdf`, mimeType: "application/pdf", buffer: pdf },
      document_type: "manual",
      item_ids: item.id,
    } });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    const manual = await upload.json();
    expect(manual.title).toBe(TITLE);
    await expect.poll(async () =>
      (await (await request.get(`/api/v1/documents/${manual.id}`)).json()).ocr_status,
    { timeout: 30_000 }).toBe("succeeded");
    // Every page is read in the background and the assistant's provider builds the map.
    await expect.poll(async () => {
      const text = await (await request.get(`/api/v1/documents/${manual.id}/text`)).json();
      return [text.pages_read, text.page_total, text.reading];
    }, { timeout: 30_000 }).toEqual([3, 3, false]);
    await expect.poll(() => mapsBuilt, { timeout: 30_000 }).toBeGreaterThan(mapsBefore);

    // On the item page the manual shows its pages, and a question goes to the assistant:
    // the item has no question dialog of its own.
    await page.goto(`/items/${item.id}?tab=documents`);
    const section = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Documents & manuals" }),
    });
    await expect(section.getByText("3 pages", { exact: true })).toBeVisible();
    await expect(section.getByText(/Questions about manuals need the AI assistant/)).toHaveCount(0);
    await section.getByRole("button", { name: "Ask about this item" }).click();
    await expect(page).toHaveURL(/#assistant$/);
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask attached manuals" })).toHaveCount(0);

    await page.goto("/items");
    await ask(page, "Show me the multimeter documentation", true);
    const shown = page.getByLabel("Assistant tool task").last();
    await expect(shown.getByTestId("answer-text")).toHaveText(`Your multimeter's manual is ${TITLE}.`);
    // Open leads to the file viewer. The document page is a separate Details link.
    const open = shown.getByRole("link", { name: `Open ${TITLE}`, exact: true });
    await expect(open).toHaveAttribute("href", new RegExp(`^/documents/${manual.id}/view(\\?|$)`));
    await expect(shown.getByRole("link", { name: `Details of ${TITLE}`, exact: true }))
      .toHaveAttribute("href", new RegExp(`^/documents/${manual.id}(\\?|$)`));
    await expect(shown.getByRole("link", { name: `Download ${TITLE}`, exact: true }))
      .toHaveAttribute("href", `/api/v1/documents/${manual.id}/file`);
    // Showing a manual opens no capture or extraction review.
    await expect(page.getByLabel("Assistant capture status")).toHaveCount(0);
    await expect(page.getByLabel("Assistant document review")).toHaveCount(0);

    await ask(page, "How do I check amperage?");
    const answered = page.getByLabel("Assistant tool task").last();
    await expect(answered.getByTestId("answer-text")).toContainText("move the red lead to the 10A jack");
    await expect(answered.getByTestId("answer-text")).toContainText(`(${TITLE}, page 2)`);
    const citations = answered.getByRole("list", { name: "Manual citations" });
    await expect(citations.getByRole("link", { name: `${TITLE}, page 2`, exact: true }))
      .toHaveAttribute("href", new RegExp(`^/documents/${manual.id}/view\\?page=2(&|$)`));
    // The words quoted next to the link stand on that page of the file.
    await expect(citations.getByText(`“${PAGES[1]![1]}”`)).toBeVisible();

    await ask(page, "And the battery?");
    const battery = page.getByLabel("Assistant tool task").last();
    await expect(battery.getByTestId("answer-text")).toContainText(`(${TITLE}, page 3)`);
    await expect(page.getByLabel("Assistant capture status")).toHaveCount(0);
    await expect(page.getByLabel("Assistant document review")).toHaveCount(0);
    const captures = await (await request.get("/api/v1/inventory-review/captures")).json();
    expect(captures.filter((capture: { id: string }) => capture.id === manual.id)).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`manual-answer-${mobile ? "mobile" : "desktop"}.png`),
    });

    // Open shows the stored file itself.
    const requests: string[] = [];
    const documentApi = `/api/v1/documents/${manual.id}`;
    page.on("request", (sent) => {
      const { pathname } = new URL(sent.url());
      if (pathname.startsWith(documentApi)) {
        requests.push(`${sent.method()} ${pathname.slice(documentApi.length) || "/"}`);
      }
    });
    const [served] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `${documentApi}/file`),
      open.click(),
    ]);
    await expect(page).toHaveURL(new RegExp(`/documents/${manual.id}/view$`));
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("application/pdf");
    // The file is still only served as an attachment; the page draws it.
    expect(served.headers()["content-disposition"]).toContain("attachment");
    expect((await served.body()).equals(pdf)).toBeTruthy();
    await expect(page.getByRole("heading", { name: TITLE, exact: true })).toBeVisible();
    const viewer = page.getByRole("region", { name: `Pages of ${TITLE}`, exact: true });
    await expect(viewer.getByText("3 pages", { exact: true })).toBeVisible();
    const inked: number[] = [];
    for (const number of [1, 2, 3]) {
      const drawn = viewer.locator(`[data-page="${number}"]`);
      await drawn.scrollIntoViewIfNeeded();
      await expect(drawn).toHaveAttribute("data-state", "drawn");
      const canvas = viewer.getByRole("img", { name: `Page ${number} of 3`, exact: true });
      await expect(canvas).toBeVisible();
      inked.push(await ink(canvas));
    }
    // Every page is white paper with some text on it, and the pages are not all alike:
    // the second page of the file has the most text.
    for (const share of inked) {
      expect(share).toBeGreaterThan(0.0002);
      expect(share).toBeLessThan(0.05);
    }
    expect(inked[1]).toBeGreaterThan(inked[0]!);
    expect(inked[1]).toBeGreaterThan(inked[2]!);
    // The pages are drawn by the app, not handed to the browser's own PDF viewer.
    await expect(page.locator("iframe, embed, object")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(viewer.locator('[data-page="1"]')).toHaveAttribute("data-state", "drawn");
    await page.screenshot({
      path: test.info().outputPath(`manual-viewer-${mobile ? "mobile" : "desktop"}.png`),
    });

    // Opening the file neither starts nor shows an extraction review.
    await expect(page.locator("#document-extraction-review")).toHaveCount(0);
    await expect(page.getByText(/extraction review/i)).toHaveCount(0);
    await expect(page.getByLabel("Document processing")).toHaveCount(0);
    expect([...new Set(requests)].sort()).toEqual(["GET /", "GET /file"]);

    // Reopening the assistant on the viewer does not pull the manual into a review.
    await page.locator('button[title="Open assistant"]').first().click();
    await expect(page.getByLabel("Assistant tool task").last().getByTestId("answer-text"))
      .toContainText(`(${TITLE}, page 3)`);
    await expect(page.getByLabel("Assistant document review")).toHaveCount(0);
    await expect(page.getByLabel("Assistant capture status")).toHaveCount(0);

    // A citation opens the same viewer at the cited page.
    const citation = page.locator(`a[href^="/documents/${manual.id}/view?page=2"]`);
    await expect(citation).toHaveText(`${TITLE}, page 2`);
    await citation.click();
    await expect(page).toHaveURL(new RegExp(`/documents/${manual.id}/view\\?page=2$`));
    const cited = viewer.locator('[data-page="2"]');
    await expect(cited).toHaveAttribute("data-state", "drawn");
    await expect(cited).toBeInViewport();
    expect([...new Set(requests)].sort()).toEqual(["GET /", "GET /file"]);
    // How far down page 2 the bottom edge of the toolbar is, as a share of the page.
    const reading = () => viewer.evaluate((section) => {
      const line = section.firstElementChild!.getBoundingClientRect().bottom;
      const box = section.querySelector('[data-page="2"]')!.getBoundingClientRect();
      return (line - box.top) / box.height;
    });
    // The assistant closes and, on a wide screen, the pages grow into the room it leaves:
    // a page is as wide as its frame, up to 900 pixels.
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeHidden();
    await expect.poll(() => viewer.evaluate((section) =>
      section.querySelector<HTMLElement>('[data-page="2"]')!.offsetWidth
        - Math.min(section.lastElementChild!.clientWidth, 900))).toBe(0);
    // The cited page still starts right under the toolbar, not behind it or far below.
    const landed = await reading();
    expect(landed).toBeLessThanOrEqual(0);
    expect(landed).toBeGreaterThan(-0.05);

    // Zooming keeps the place being read: the same part of the page stays under the toolbar.
    await page.evaluate(() => window.scrollBy({ top: 200, behavior: "instant" }));
    const place = await reading();
    expect(place).toBeGreaterThan(0.1);
    expect(place).toBeLessThan(0.9);
    await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(cited).toHaveAttribute("data-state", "drawn");
    expect(await reading()).toBeCloseTo(place, 2);

    // The jump to a cited page does not depend on where focus is. Here the search
    // shortcut moves focus to the header while the file is still loading.
    await page.route(`**${documentApi}/file`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.goto(`/documents/${manual.id}/view?page=2`);
    const search = page.getByRole("combobox", { name: "Search or ask about your inventory" });
    await expect(search).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    await expect(cited).toHaveAttribute("data-state", "drawn");
    await expect(search).toBeFocused();
    const withFocusInHeader = await reading();
    expect(withFocusInHeader).toBeLessThanOrEqual(0);
    expect(withFocusInHeader).toBeGreaterThan(-0.05);
    await page.unroute(`**${documentApi}/file`);

    // Managing the document, with its extraction review, stays a separate page.
    await page.getByRole("link", { name: "Details", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${manual.id}$`));
    await expect(page.locator("#document-extraction-review")).toBeVisible();
    // The text of every page is there to read, with a link to each page of the file.
    await page.locator("summary").filter({ hasText: "Extracted text" }).click();
    await expect(page.getByText("3 of 3 pages read", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Text of page 2", exact: true }))
      .toContainText("move the red lead to the 10A jack");
    await expect(page.getByRole("link", { name: "Page 2", exact: true }))
      .toHaveAttribute("href", `/documents/${manual.id}/view?page=2`);
  });
}
