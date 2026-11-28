import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * Touch target audit. On a touch phone every control must have a clickable area
 * of at least 44 x 44 CSS px, and no control may take taps that belong to the
 * drawn box of its neighbour.
 *
 * How the area is measured. A control's clickable area is its own box plus what
 * really extends it: its padding, a <label> around it or pointing at it, and a
 * pseudo-element laid over or around it. Nothing of this is assumed. From the
 * centre of the control the audit walks outwards along both axes and asks the
 * browser which element is under each point (document.elementFromPoint). A point
 * counts when the answer is the control, something inside it, or its label. A
 * pseudo-element answers as the control it belongs to. The walk stops at the
 * first point that belongs to something else, so an area covered by a neighbour
 * is not counted.
 *
 * Allowed exceptions (WCAG 2.5.8 and 2.5.5), and nothing more:
 * - a link or text button inside a sentence or block of text;
 * - a control whose size the browser sets and the app does not change.
 * Native checkboxes, radio buttons and selects of the app are not exempt.
 *
 * Set TOUCH_AUDIT_REPORT to a file path to get every finding as one JSON line.
 */

const MIN = 44;
const PHONES = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];
// A tablet held sideways: touch, and wide enough for the sidebar.
const TABLET = { width: 1180, height: 820 };

interface Finding {
  screen: string;
  viewport: string;
  /**
   * small: under 44 px. stolen: part of its box answers as another control.
   * covered: cannot be tapped at all. zoomed: the page is wider than the screen,
   * so a phone shows all of it smaller and 44 px are no longer 44.
   */
  kind: "small" | "stolen" | "covered" | "zoomed";
  name: string;
  tag: string;
  cls: string;
  /** The clickable area, in px. */
  area: string;
  /** The drawn box, in px. */
  box: string;
  by?: string;
  count: number;
}

/** Runs in the page. Returns the controls of the current screen that fail. */
function auditInPage(min: number) {
  // Far enough that one side alone can make up the 44 px (a checkbox at the start of its label).
  const REACH = 44;
  const CONTROLS = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="tab"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="link"]',
  ].join(",");

  const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const describe = (element: Element) =>
    text(
      element.getAttribute("aria-label") ||
        element.textContent ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("name") ||
        element.id,
    ).slice(0, 60) || `<${element.tagName.toLowerCase()}>`;
  const classes = (element: Element) => text(element.getAttribute("class")).slice(0, 90);

  const rendered = (element: Element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.getClientRects().length === 0) return false;
    // False inside a closed <details>, whose content keeps its boxes.
    if (!element.checkVisibility()) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.pointerEvents === "none") return false;
    // Behind an open dialog, or switched off for assistive tools: not a target now.
    if (element.closest('[aria-hidden="true"], [inert]')) return false;
    return true;
  };
  const tiny = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width <= 2 || box.height <= 2 || Number(getComputedStyle(element).opacity) === 0;
  };

  /** A link or text button that is part of a sentence. */
  const inSentence = (element: Element) => {
    if (!element.matches('a, button, [role="link"]')) return false;
    if (getComputedStyle(element).display !== "inline") return false;
    let around = "";
    for (const node of Array.from(element.parentNode?.childNodes ?? [])) {
      if (node === element) continue;
      if (node.nodeType === Node.TEXT_NODE) around += node.textContent ?? "";
      else if (node instanceof HTMLElement && !node.matches(CONTROLS)) {
        if (getComputedStyle(node).display === "inline") around += node.textContent ?? "";
      }
    }
    return around.replace(/[^\p{L}\p{N}]/gu, "").length >= 3;
  };

  /** A control drawn by the browser at the browser's own size. */
  const sizedByBrowser = (element: Element) =>
    element.matches(
      'input[type="file"], input[type="color"], input[type="range"], audio[controls], video[controls]',
    ) &&
    !element.getAttribute("class") &&
    !element.getAttribute("style");

  interface Target {
    element: HTMLElement;
    /** Elements whose area also belongs to this control. */
    extra: HTMLElement[];
  }
  const targets: Target[] = [];
  const seen = new Set<Element>();
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(CONTROLS))) {
    if (!rendered(element)) continue;
    if ((element as HTMLButtonElement).disabled) continue;
    if (element instanceof HTMLInputElement && element.type === "hidden") continue;
    if (sizedByBrowser(element) || inSentence(element)) continue;
    const labels = Array.from((element as HTMLInputElement).labels ?? []) as HTMLElement[];
    const wrapping = element.closest("label");
    if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
    const shown = labels.filter(rendered);
    if (tiny(element)) {
      // A hidden native control: its label is what people tap.
      if (shown.length === 0 || seen.has(shown[0]!)) continue;
      seen.add(shown[0]!);
      targets.push({ element: shown[0]!, extra: [element, ...shown.slice(1)] });
      continue;
    }
    targets.push({ element, extra: shown });
  }
  // A label for a control that is not shown at all (a hidden file input, for example).
  for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>("label"))) {
    const control = label.control;
    if (!control || seen.has(label) || !rendered(label)) continue;
    if ((control as HTMLInputElement).disabled) continue;
    if (control.getClientRects().length > 0 && !tiny(control) && !control.closest('[aria-hidden="true"]')) continue;
    if (control instanceof HTMLInputElement && control.type === "hidden") continue;
    seen.add(label);
    targets.push({ element: label, extra: [control] });
  }

  const found = new Map<
    string,
    { kind: string; name: string; tag: string; cls: string; area: string; box: string; by?: string; count: number }
  >();
  const add = (kind: string, target: Target, area: string, by?: string) => {
    const { element } = target;
    const box = element.getBoundingClientRect();
    const key = [kind, element.tagName, element.getAttribute("role"), classes(element), area, by].join("|");
    const known = found.get(key);
    if (known) known.count += 1;
    else {
      found.set(key, {
        kind,
        name: describe(element),
        tag:
          element.tagName.toLowerCase() +
          (element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : "") +
          (element instanceof HTMLInputElement ? `[type=${element.type}]` : ""),
        cls: classes(element),
        area,
        box: `${Math.round(box.width)}x${Math.round(box.height)}`,
        by,
        count: 1,
      });
    }
  };

  /**
   * True when `blocker` is part of a layer that floats over `element` for now: a
   * fixed layer the control is not in, or something laid over the list that
   * scrolls the control (the list can be scrolled out from under it).
   */
  const onTopLayer = (blocker: Element, element: Element) => {
    let scroller: Element | null = null;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        scroller = node;
        break;
      }
    }
    for (let node: Element | null = blocker; node && node !== document.body; node = node.parentElement) {
      if (node.contains(element)) break;
      // The bar and the sidebar are always there. A control under them is a real fault.
      if (node.hasAttribute("data-always-on-screen")) return false;
      if (getComputedStyle(node).position === "fixed") return true;
    }
    return scroller !== null && !scroller.contains(blocker);
  };

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  for (const target of targets) {
    const { element, extra } = target;
    const own = (hit: Element | null) =>
      hit !== null &&
      (hit === element || element.contains(hit) || extra.some((part) => part === hit || part.contains(hit)));
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;

    // Bring the control to the middle of the screen (or of the sheet or list that
    // scrolls it) and find a point of it that can be tapped. The other positions
    // are tried when something is over it there.
    let centre: { x: number; y: number } | null = null;
    let blocker: Element | null = null;
    for (const block of ["center", "start", "end", "nearest"] as const) {
      element.scrollIntoView({ block, inline: "center", behavior: "instant" });
      const boxes = [element, ...extra].map((part) => part.getBoundingClientRect()).filter((box) => box.width > 2);
      for (const box of boxes) {
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (!inside(x, y)) continue;
        const hit = document.elementFromPoint(x, y);
        if (own(hit)) {
          centre = { x, y };
          break;
        }
        // What is over it in the middle of the screen is what counts.
        if (block === "center" || !blocker) blocker = hit;
      }
      if (centre) break;
      // Under a layer that is on top for now (a menu, a sheet, a message, the
      // matches of the search field): not a target at this moment.
      if (block === "center" && blocker && onTopLayer(blocker, element)) break;
    }
    if (!centre) {
      if (blocker && !onTopLayer(blocker, element)) {
        add(
          "covered",
          target,
          "0x0",
          `${describe(blocker.closest(CONTROLS) ?? blocker)} <${blocker.tagName.toLowerCase()} ${classes(blocker).slice(0, 50)}>`,
        );
      }
      continue;
    }

    // Walk outwards from that point. Half-pixel steps, so a 44 px box reads as 44.
    const walk = (dx: number, dy: number) => {
      let reached = 0;
      for (let distance = 0.5; distance <= REACH; distance += 0.5) {
        const x = centre!.x + dx * distance;
        const y = centre!.y + dy * distance;
        if (!inside(x, y)) break;
        const hit = document.elementFromPoint(x, y);
        if (!own(hit)) {
          // A layer that floats over the page for now hides the rest of this
          // control. That is not its size, so this side is not judged.
          if (hit && onTopLayer(hit, element)) return REACH;
          break;
        }
        reached = distance;
      }
      return reached;
    };
    const width = walk(-1, 0) + walk(1, 0);
    const height = walk(0, -1) + walk(0, 1);
    if (width < min - 0.5 || height < min - 0.5) {
      add("small", target, `${Math.round(width)}x${Math.round(height)}`);
    }

    // Is part of the control's own drawn box answered by another control's unseen area?
    const box = element.getBoundingClientRect();
    let thief: Element | null = null;
    for (let row = 0; row < 5 && !thief; row += 1) {
      for (let column = 0; column < 5 && !thief; column += 1) {
        const x = box.left + 1 + ((box.width - 2) * column) / 4;
        const y = box.top + 1 + ((box.height - 2) * row) / 4;
        if (!inside(x, y)) continue;
        const hit = document.elementFromPoint(x, y);
        if (own(hit)) continue;
        const other = hit?.closest(CONTROLS);
        if (!other || other === element || other.contains(element) || element.contains(other)) continue;
        if (onTopLayer(other, element)) continue;
        const otherBox = other.getBoundingClientRect();
        const drawnThere = x >= otherBox.left && x <= otherBox.right && y >= otherBox.top && y <= otherBox.bottom;
        // Two drawn boxes on top of each other (a clear button inside a field) are
        // seen by the eye. An unseen area over a neighbour is not.
        if (!drawnThere) thief = other;
      }
    }
    if (thief) add("stolen", target, `${Math.round(width)}x${Math.round(height)}`, describe(thief));
  }
  window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
  return { checked: targets.length, findings: Array.from(found.values()) };
}

class Audit {
  readonly findings: Finding[] = [];
  readonly screens: Array<{ screen: string; checked: number; findings: number }> = [];
  constructor(
    readonly page: Page,
    readonly viewport: string,
  ) {}

  /** Measures every control that is on the screen now. */
  async check(screen: string) {
    const { page } = this;
    // Let slide-in and fade-in animations end, so boxes are where they stay.
    // Two seconds at most: a spinner never ends.
    await page.evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        ),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]),
    );
    await page.waitForTimeout(150);
    const result = await page.evaluate(auditInPage, MIN);
    expect(result.checked, `${screen}: nothing to measure`).toBeGreaterThan(0);
    // A page wider than the screen is shown zoomed out by a phone.
    const width = await page.evaluate(() => Math.max(window.innerWidth, document.documentElement.scrollWidth));
    if (width > Number(this.viewport.split("x")[0]) + 1) {
      result.findings.push({
        kind: "zoomed",
        name: "the page",
        tag: "html",
        cls: "",
        area: `${width} px wide`,
        box: this.viewport,
        count: 1,
      });
    }
    for (const finding of result.findings) {
      this.findings.push({ ...(finding as Omit<Finding, "screen" | "viewport">), screen, viewport: this.viewport });
    }
    this.screens.push({ screen, checked: result.checked, findings: result.findings.length });
    if (process.env.TOUCH_AUDIT_REPORT) {
      const lines = [
        { type: "screen", screen, viewport: this.viewport, checked: result.checked, findings: result.findings.length },
        ...result.findings.map((finding) => ({ type: "finding", screen, viewport: this.viewport, ...finding })),
      ];
      fs.appendFileSync(process.env.TOUCH_AUDIT_REPORT, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    }
  }
}

/** Opens a touch context of one size, runs the walk, and closes it. */
async function onTouchScreen(
  browser: Browser,
  testInfo: TestInfo,
  size: { width: number; height: number },
  walk: (audit: Audit, context: BrowserContext) => Promise<void>,
  options: { signedOut?: boolean } = {},
) {
  const use = testInfo.project.use;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    storageState: options.signedOut ? undefined : (use.storageState as string),
    viewport: size,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: use.ignoreHTTPSErrors,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const audit = new Audit(page, `${size.width}x${size.height}`);
  try {
    await page.goto(options.signedOut ? "/login" : "/items");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch layout").toBe(true);
    await walk(audit, context);
  } finally {
    await context.close();
  }
  return audit;
}

/**
 * Known findings that are not fixed yet. The list is empty now. A finding put
 * here is reported, not hidden: every run attaches it.
 * A line must be deleted when its control is fixed. The test fails when a line
 * no longer matches anything, so this list cannot go stale.
 */
const PENDING: Array<{ screen: RegExp; name: RegExp; why: string }> = [];

/** Fails the test when a screen has a control under 44 px, and says which. */
async function report(testInfo: TestInfo, audits: Audit[]) {
  const all = audits.flatMap((audit) => audit.findings);
  const screens = audits.flatMap((audit) =>
    audit.screens.map((entry) => ({ ...entry, viewport: audit.viewport })),
  );
  const pendingFor = (entry: Finding) =>
    PENDING.find((known) => known.screen.test(entry.screen) && known.name.test(entry.name));
  const findings = all.filter((entry) => !pendingFor(entry));
  await testInfo.attach("touch-targets.json", {
    body: JSON.stringify({ screens, findings, pending: all.filter(pendingFor) }, null, 2),
    contentType: "application/json",
  });
  // A known finding that is gone must leave the list.
  for (const known of PENDING) {
    if (!screens.some((entry) => known.screen.test(entry.screen))) continue;
    expect(
      all.some((entry) => known.screen.test(entry.screen) && known.name.test(entry.name)),
      `Fixed, so delete it from PENDING: ${known.why}`,
    ).toBe(true);
  }
  expect(
    findings.map(
      (entry) =>
        `${entry.viewport} ${entry.screen}: ${entry.kind} ${entry.area} (drawn ${entry.box}) ${entry.tag} "${entry.name}"` +
        `${entry.by ? ` by "${entry.by}"` : ""}${entry.count > 1 ? ` x${entry.count}` : ""} [${entry.cls}]`,
    ),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Data for the screens
// ---------------------------------------------------------------------------

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAaElEQVR4nNXOQREAIAzAsFKZiEAJohGxB9coyNr3UCZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQD/V4BtOYVtIgAAAAASUVORK5CYII=",
  "base64",
);

interface Seed {
  roomId: string;
  /** A room inside the room, and a room inside that one: /rooms lists them in the room's card. */
  nookId: string;
  nookName: string;
  alcoveName: string;
  containerId: string;
  itemId: string;
  itemName: string;
  plainItemId: string;
  loanId: string;
  documentId: string;
  /** The warranty of the main item links to this document. */
  documentTitle: string;
  stocktakeId: string;
  importId: string;
}

let seeded: Promise<Seed> | undefined;

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function seedData(request: APIRequestContext): Promise<Seed> {
  const tag = Date.now().toString().slice(-6);
  const room = await post<{ id: string }>(request, "/api/v1/rooms", { name: `Touch room ${tag}` });
  const nookName = `Touch nook ${tag}`;
  const alcoveName = `Touch alcove ${tag}`;
  const nook = await post<{ id: string }>(request, "/api/v1/rooms", { name: nookName, parent_id: room.id });
  await post(request, "/api/v1/rooms", { name: alcoveName, parent_id: nook.id });
  const container = await post<{ id: string }>(request, "/api/v1/containers", {
    room_id: room.id,
    container_type: "box",
    name: `Touch box ${tag}`,
  });
  await post(request, "/api/v1/storage-locations", { room_id: room.id, name: `Touch shelf ${tag}`, kind: "shelf" });
  const category = await post<{ id: string }>(request, "/api/v1/categories", { name: `Touch tools ${tag}` });
  const label = await post<{ id: string }>(request, "/api/v1/tags", { name: `touch-${tag}` });
  const itemName = `Touch drill ${tag}`;
  const main = await post<{ item: { id: string } }>(request, "/api/v1/items", {
    name: itemName,
    brand: "Makita",
    model: "HP-2",
    quantity: 3,
    room_id: room.id,
    storage_location_id: container.id,
    category_id: category.id,
    tag_ids: [label.id],
    description: "Seeded for the touch target audit.",
    purchase: { merchant: `Touch shop ${tag}`, purchase_date: "2026-02-01", price_cents: 12900, currency: "USD" },
    warranty: { provider: "Makita", start_date: "2026-02-01", duration_months: 24 },
    current_value_cents: 9000,
    current_value_currency: "USD",
  });
  const photo = await request.post(`/api/v1/items/${main.item.id}/photos`, {
    multipart: { files: { name: "touch.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(photo.ok(), await photo.text()).toBeTruthy();
  let plainItemId = "";
  // Two items with one name, so the review has something to suggest.
  for (const name of [`Touch lamp ${tag}`, `Touch lamp ${tag}`, `Touch chair ${tag}`, `Touch stool ${tag}`]) {
    const created = await post<{ item: { id: string } }>(request, "/api/v1/items", { name, room_id: room.id });
    plainItemId = created.item.id;
  }
  const loan = await post<{ id: string }>(request, "/api/v1/loans", {
    item_id: main.item.id,
    borrower_name: `Touch borrower ${tag}`,
    quantity: 1,
    lent_on: "2026-10-01",
    due_on: "2026-10-20",
    request_id: crypto.randomUUID(),
  });
  await post(request, "/api/v1/borrowed", {
    item_name: `Touch borrowed ladder ${tag}`,
    owner_name: "Ali",
    quantity: 1,
    borrowed_on: "2026-10-01",
    request_id: crypto.randomUUID(),
  });
  const uploaded = await request.post("/api/v1/documents", {
    multipart: {
      file: { name: "touch-receipt.txt", mimeType: "text/plain", buffer: Buffer.from("Touch audit receipt.") },
      title: `Touch receipt ${tag}`,
      document_type: "receipt",
      item_ids: main.item.id,
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const document = (await uploaded.json()) as { id: string };
  // The warranty points at the receipt, so /warranties shows the link to it.
  const linked = await request.patch(`/api/v1/items/${main.item.id}`, {
    data: {
      warranty: { provider: "Makita", start_date: "2026-02-01", duration_months: 24, document_id: document.id },
    },
  });
  expect(linked.ok(), await linked.text()).toBeTruthy();
  const stocktake = await post<{ id: string }>(request, "/api/v1/stocktake/sessions", {
    room_ids: [room.id],
    container_ids: [],
    include_descendants: true,
    request_id: crypto.randomUUID(),
  });
  const imported = await request.post("/api/v1/imports", {
    multipart: { text: `- Touch kettle ${tag}\n- Touch toaster ${tag}\n- Touch blender ${tag}` },
  });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  const batch = (await imported.json()) as { id: string };
  await expect
    .poll(async () => ((await (await request.get(`/api/v1/imports/${batch.id}`)).json()) as { status: string }).status, {
      timeout: 30_000,
    })
    .toBe("review");
  return {
    roomId: room.id,
    containerId: container.id,
    itemId: main.item.id,
    itemName,
    plainItemId,
    loanId: loan.id,
    documentId: document.id,
    documentTitle: `Touch receipt ${tag}`,
    stocktakeId: stocktake.id,
    importId: batch.id,
    nookId: nook.id,
    nookName,
    alcoveName,
  };
}

/**
 * The data is made once and used by every test here, also after a failed test
 * (which starts a new worker) and on the next run against the same stack.
 */
const SEED_FILE = "./e2e/.auth/touch-targets-seed.json";

async function reuseOrSeed(request: APIRequestContext, baseURL: string): Promise<Seed> {
  let known: Record<string, Seed> = {};
  try {
    known = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) as Record<string, Seed>;
  } catch {
    // No data made yet.
  }
  const earlier = known[baseURL];
  if (earlier) {
    const item = await request.get(`/api/v1/items/${earlier.itemId}`);
    const stocktake = await request.get(`/api/v1/stocktake/sessions/${earlier.stocktakeId}`);
    const batch = await request.get(`/api/v1/imports/${earlier.importId}`);
    const nook = earlier.nookId ? await request.get(`/api/v1/rooms/${earlier.nookId}`) : undefined;
    if (
      earlier.documentTitle &&
      nook?.ok() &&
      item.ok() &&
      stocktake.ok() &&
      ((await stocktake.json()) as { status: string }).status === "in_progress" &&
      batch.ok() &&
      ((await batch.json()) as { status: string }).status === "review"
    ) {
      return earlier;
    }
    // The old stocktake is in the way of a new one. It is given up, not deleted.
    if (stocktake.ok()) {
      await request.post(`/api/v1/stocktake/sessions/${earlier.stocktakeId}/abandon`, {
        data: { request_id: crypto.randomUUID() },
      });
    }
  }
  const fresh = await seedData(request);
  fs.mkdirSync("./e2e/.auth", { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify({ ...known, [baseURL]: fresh }, null, 2));
  return fresh;
}

function seed(request: APIRequestContext) {
  seeded ??= reuseOrSeed(request, test.info().project.use.baseURL ?? "");
  return seeded;
}

/** /rooms must show the room card with a nested room and one two levels deep, so their links are measured. */
async function expectNestedRooms(page: Page, data: Seed) {
  for (const name of [data.nookName, data.alcoveName]) {
    await expect(main(page).getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
}

/**
 * One provider with a model list. Its own default model, the default text model
 * and one task's model are chosen, so the model pickers show a value and "Clear".
 */
async function addModelProvider(request: APIRequestContext) {
  const settings = (await (await request.get("/api/v1/ai/settings")).json()) as { providers: Array<{ id: string }> };
  for (const provider of settings.providers) await request.delete(`/api/v1/ai/providers/${provider.id}`);
  const origin = aiBaseUrl ? new URL(aiBaseUrl).origin : `http://host.docker.internal:${modelPort}`;
  const provider = await post<{ id: string }>(request, "/api/v1/ai/providers", {
    provider: "openrouter",
    display_name: "Touch audit provider",
    base_url: `${origin}/api/v1`,
    default_model: "touch/model-3",
    api_key: "sk-touch-audit-not-real",
    enabled: true,
    cloud_consent: true,
  });
  // Reading the model list once fills the model pickers.
  expect((await request.get(`/api/v1/ai/providers/${provider.id}/models`)).ok()).toBeTruthy();
  const chosen = await request.put("/api/v1/ai/default-text", { data: { provider_id: provider.id, model: "touch/model-1" } });
  expect(chosen.ok(), await chosen.text()).toBeTruthy();
  const task = await request.put("/api/v1/ai/tasks/documents", {
    data: { provider_id: provider.id, model: "touch/model-2", enabled: true, inherit_default: false },
  });
  expect(task.ok(), await task.text()).toBeTruthy();
  return provider;
}

/** On /settings/ai: at least one model picker has a value, so its "Clear" button is on the page. */
async function expectChosenModel(page: Page) {
  await expect(page.getByRole("button", { name: /^Clear .+ model$/ }).first()).toBeVisible();
}

/**
 * /settings/ai with a provider: the task rows with a model of their own, then the
 * provider dialog with a chosen model (its "Clear" button) and the open model list.
 */
async function aiSettingsParts(audit: Audit, screen: string) {
  const { page } = audit;
  await open(page.getByText("Advanced task overrides"));
  await expect(page.getByRole("button", { name: "Clear Document interpretation model" })).toBeVisible();
  await audit.check(`${screen}, task overrides open`);
  await open(page.getByRole("button", { name: "Edit provider" }));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit provider" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Clear Default model" })).toBeVisible();
  await audit.check(`${screen}, provider dialog`);
  await dialog.getByRole("combobox", { name: "Default model" }).click();
  await expect(dialog.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await audit.check(`${screen}, model picker open`);
  await page.keyboard.press("Escape");
  await closeDialog(page);
}

/** Opens a closed part of a page when it is there and closed. */
async function open(locator: Locator) {
  await expect(locator.first()).toBeVisible();
  await locator.first().click();
}

const main = (page: Page) => page.getByRole("main");

/** Closes the open dialog or sheet with its own Close button. */
async function closeDialog(page: Page) {
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: /^Close/ }).first().click();
  await expect(dialog).toBeHidden();
}

// ---------------------------------------------------------------------------
// The walks
// ---------------------------------------------------------------------------

test("items, an item and the item form", async ({ browser, request }, testInfo) => {
  test.setTimeout(240_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(browser, testInfo, size, async (audit) => {
        const { page } = audit;
        await page.goto("/items");
        await expect(main(page).getByRole("link", { name: new RegExp(data.itemName) }).first()).toBeVisible();
        await audit.check("/items rows");
        await page.getByRole("button", { name: "Card view" }).click();
        await audit.check("/items cards");
        await page.getByRole("button", { name: "Compact list view" }).click();
        await open(main(page).getByRole("button", { name: "Filters" }));
        await expect(page.getByLabel("Filter by room")).toBeVisible();
        await audit.check("/items Filters open");
        // A filter in use shows as a chip with its own remove button.
        await page.getByLabel("Filter by room").selectOption({ index: 1 });
        await expect(main(page).getByRole("button", { name: /^Remove / }).first()).toBeVisible();
        await audit.check("/items with a filter chip");
        await main(page).getByRole("button", { name: /^Remove / }).first().click();
        await main(page).getByRole("button", { name: "Filters" }).first().click();
        await open(main(page).getByRole("button", { name: /^Select/ }));
        await page.getByRole("checkbox", { name: new RegExp(`Select ${data.itemName}`) }).first().check();
        await expect(page.getByRole("button", { name: "Clear" }).first()).toBeVisible();
        await audit.check("/items Select mode with the bulk bar");

        await page.goto(`/items/${data.itemId}`);
        await expect(page.getByRole("heading", { name: data.itemName, level: 1 })).toBeVisible();
        for (const tab of await page.getByRole("tab").all()) {
          const name = (await tab.innerText()).replace(/\s*\d+$/, "").trim();
          await tab.click();
          await audit.check(`item page, ${name} tab`);
        }
        await page.getByRole("tab", { name: /^Info/ }).click();
        await open(page.getByText("Record details", { exact: false }));
        await audit.check("item page, record details open");
        await open(page.getByRole("button", { name: "Manage photos" }));
        await audit.check("item page, Manage photos open");
        await open(page.getByRole("button", { name: "Item options" }));
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("item page, options menu");
        await page.keyboard.press("Escape");
        await open(page.getByRole("button", { name: /^Lend/ }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("item page, lend dialog");
        await closeDialog(page);
        await open(page.getByRole("button", { name: "Move", exact: true }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("item page, move dialog");
        await closeDialog(page);

        for (const [path, screen] of [
          [`/items/${data.itemId}/edit`, "item edit"],
          ["/items/new", "item new"],
        ] as const) {
          await page.goto(path);
          await expect(page.getByLabel("Item name")).toBeVisible();
          await audit.check(`${screen}, closed`);
          await open(page.getByRole("button", { name: /^Place/ }));
          for (const part of [/^Identity & organisation/, /^Purchase/, /^Warranty/]) {
            await open(page.getByRole("button", { name: part }));
          }
          await expect(page.getByLabel("Brand")).toBeVisible();
          await audit.check(`${screen}, place and optional parts open`);
        }
      }),
    );
  }
  await report(testInfo, audits);
});

test("places: rooms, a room, containers, a container and labels", async ({ browser, request }, testInfo) => {
  test.setTimeout(240_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(browser, testInfo, size, async (audit) => {
        const { page } = audit;
        await page.goto("/rooms");
        await expect(page.getByRole("heading", { name: "Rooms", level: 1 })).toBeVisible();
        await expectNestedRooms(page, data);
        await audit.check("/rooms");
        await open(main(page).getByRole("button", { name: "Add a room" }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("/rooms, new room dialog");
        await closeDialog(page);

        await page.goto(`/rooms/${data.roomId}`);
        await expect(main(page).getByRole("link", { name: new RegExp(data.itemName) }).first()).toBeVisible();
        await audit.check("room page");
        await open(main(page).getByRole("button", { name: "Filters" }));
        await audit.check("room page, Filters open");
        await open(page.getByRole("button", { name: "Room options" }));
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("room page, options menu");
        await page.keyboard.press("Escape");

        await page.goto("/containers");
        await expect(page.getByRole("heading", { name: "Containers", level: 1 })).toBeVisible();
        await audit.check("/containers");
        await open(main(page).getByRole("button", { name: /New container/ }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("/containers, new container dialog");
        await closeDialog(page);

        await page.goto(`/containers/${data.containerId}`);
        await expect(main(page).getByRole("link", { name: new RegExp(data.itemName) }).first()).toBeVisible();
        await audit.check("container page");
        await open(main(page).getByRole("button", { name: "Filters" }));
        await audit.check("container page, Filters open");
        await open(page.getByRole("button", { name: "Container options" }));
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("container page, options menu");
        await page.keyboard.press("Escape");

        await page.goto(`/labels?ids=${data.containerId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("/labels");
        await open(page.getByText("Advanced · Calibration"));
        await audit.check("/labels, Advanced open");
      }),
    );
  }
  await report(testInfo, audits);
});

test("loans, documents, purchases, warranties and insurance", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(browser, testInfo, size, async (audit) => {
        const { page } = audit;
        await page.goto("/loans");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(main(page).getByText(/Touch borrower/).first()).toBeVisible();
        await audit.check("/loans");
        await open(main(page).getByRole("button", { name: /Filters/ }));
        await audit.check("/loans, Filters open");
        await page.getByLabel("Loan status").selectOption({ index: 1 });
        await expect(main(page).getByRole("button", { name: /^Remove / }).first()).toBeVisible();
        await audit.check("/loans with a filter chip");
        await main(page).getByRole("button", { name: /^Remove / }).first().click();
        await open(main(page).getByRole("button", { name: /New loan/ }));
        const loanDialog = page.getByRole("dialog");
        await expect(loanDialog).toBeVisible();
        await audit.check("/loans, new loan");
        await open(loanDialog.getByText("More options"));
        await audit.check("/loans, new loan with More options open");
        await closeDialog(page);
        await open(main(page).getByRole("button", { name: "Record return" }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("/loans, return dialog");
        await closeDialog(page);
        await page.goto(`/loans/${data.loanId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("loan page");

        await page.goto("/documents");
        await expect(main(page).getByRole("link", { name: /Touch receipt/ }).first()).toBeVisible();
        await audit.check("/documents");
        await open(main(page).getByRole("button", { name: "Filters" }));
        await audit.check("/documents, Filters open");
        await page.getByLabel("Filter by document type").selectOption({ index: 1 });
        await expect(main(page).getByRole("button", { name: /^Remove / }).first()).toBeVisible();
        await audit.check("/documents with a filter chip");
        await main(page).getByRole("button", { name: /^Remove / }).first().click();
        await expect(main(page).getByRole("link", { name: /Touch receipt/ }).first()).toBeVisible();
        await open(page.getByRole("button", { name: /^Options for Touch receipt/ }));
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("/documents, row menu");
        await page.keyboard.press("Escape");
        await open(main(page).getByRole("button", { name: "Add document" }));
        const addDocument = page.getByRole("dialog");
        await expect(addDocument).toBeVisible();
        await audit.check("/documents, add a document before a file");
        await addDocument.locator('input[type="file"]').first().setInputFiles({
          name: "touch-audit.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Touch audit upload."),
        });
        await expect(addDocument.getByRole("button", { name: /Undo/ })).toBeVisible();
        await audit.check("/documents, add a document after a file");
        for (const part of ["Attach to an item", "Add details"]) {
          await open(addDocument.getByText(part, { exact: false }));
        }
        await audit.check("/documents, add a document with its optional parts open");
        await closeDialog(page);
        await open(main(page).getByRole("button", { name: "Scan pages" }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await audit.check("/documents, scan dialog");
        await closeDialog(page);
        await page.goto(`/documents/${data.documentId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("document page");

        await page.addInitScript(() => localStorage.setItem("housetory.totals", "open"));
        await page.goto("/purchases");
        await expect(page.getByTestId("purchase-totals")).toBeVisible();
        await audit.check("/purchases, totals open");
        await open(main(page).getByRole("button", { name: /Touch shop/ }));
        await audit.check("/purchases, a row open");
        await open(main(page).getByRole("button", { name: "Filters" }));
        await audit.check("/purchases, Filters open");
        await page.getByLabel("Filter purchases by currency").selectOption({ index: 1 });
        await expect(main(page).getByRole("button", { name: /^Remove / }).first()).toBeVisible();
        await audit.check("/purchases with a filter chip");
        await main(page).getByRole("button", { name: /^Remove / }).first().click();
        await open(page.getByRole("button", { name: "More purchase actions" }));
        await audit.check("/purchases, more actions");
        await page.keyboard.press("Escape");

        await page.goto("/warranties");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(main(page).getByText(new RegExp(data.itemName)).first()).toBeVisible();
        await expect(main(page).getByRole("link", { name: data.documentTitle })).toBeVisible();
        await audit.check("/warranties");

        await page.goto("/insurance");
        await expect(page.getByLabel("Insurance scope")).toBeVisible();
        await audit.check("/insurance, Scope");
        await page.getByRole("button", { name: "Review inventory" }).click();
        await expect(page.getByLabel(`Include ${data.itemName}`)).toBeVisible();
        await audit.check("/insurance, Review");
        await page.getByRole("button", { name: "Continue to export" }).click();
        await expect(page.getByRole("button", { name: /Export|Download|Create/ }).first()).toBeVisible();
        await audit.check("/insurance, Export");
      }),
    );
  }
  await report(testInfo, audits);
});

test("stocktake, review and an import review", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(browser, testInfo, size, async (audit) => {
        const { page } = audit;
        await page.goto("/stocktake");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("/stocktake");
        await page.goto(`/stocktake/${data.stocktakeId}`);
        await expect(page.getByRole("button", { name: `Mark ${data.itemName} present` })).toBeVisible();
        await audit.check("running stocktake");
        await open(page.getByRole("button", { name: `Other results for ${data.itemName}` }));
        await audit.check("running stocktake, Other open");
        await page.keyboard.press("Escape");
        await open(page.getByRole("button", { name: "Stocktake options" }));
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("running stocktake, options menu");
        await page.keyboard.press("Escape");

        await page.goto("/review");
        await expect(page.getByRole("button", { name: "Find suggestions" })).toBeVisible();
        if ((await page.getByRole("button", { name: /^(Accept|Dismiss)/ }).count()) === 0) {
          const run = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" && response.url().endsWith("/api/v1/inventory-review/runs"),
          );
          await page.getByRole("button", { name: "Find suggestions" }).click();
          expect((await run).ok()).toBeTruthy();
        }
        await expect(page.getByRole("button", { name: /^(Accept|Dismiss)/ }).first()).toBeVisible({ timeout: 30_000 });
        await audit.check("/review with suggestions");
        await open(page.getByText("Review again options", { exact: true }));
        await open(page.getByText("Advanced · Scheduled review"));
        await audit.check("/review, options and schedule open");
        await open(page.getByRole("button", { name: /Set up schedule|Edit schedule/ }));
        await expect(page.getByRole("dialog", { name: "Scheduled inventory review" })).toBeVisible();
        await audit.check("/review, schedule dialog");
        await closeDialog(page);

        await page.goto("/imports");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("/imports");
        await page.goto(`/imports/${data.importId}`);
        const row = page.getByRole("article").first();
        await expect(row).toBeVisible();
        await audit.check("import review, rows closed");
        // A closed row's name opens in the bar editor; the rail must stay usable above it.
        await open(row.getByRole("button", { name: /^Edit name of / }));
        await expect(page.getByTestId("bar-editor")).toBeVisible();
        await audit.check("import review, a name in the bar editor");
        await page.getByRole("button", { name: "Cancel editing" }).click();
        await expect(page.getByTestId("bar-editor")).toBeHidden();
        await open(row.getByRole("button", { name: "Edit", exact: true }));
        await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
        await audit.check("import review, a row open");
        const skip = page.getByRole("article").last().getByRole("button", { name: "Skip", exact: true });
        if ((await page.getByText(/^Skipped \(\d+\)/).count()) === 0) await skip.click();
        await open(page.getByText(/^Skipped \(\d+\)/));
        await audit.check("import review, Skipped open");
      }),
    );
  }
  await report(testInfo, audits);
});

// A stand-in AI provider that lists models, so the model picker has something to show.
let modelServer: http.Server;
let modelPort = 0;
const aiBaseUrl = process.env.E2E_AI_BASE_URL;

test.beforeAll(async () => {
  modelServer = http.createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: Array.from({ length: 12 }, (_, index) => ({
          id: `touch/model-${index}`,
          name: `Touch model ${index}`,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools", "structured_outputs"],
        })),
      }),
    );
  });
  const port = aiBaseUrl ? Number(new URL(aiBaseUrl).port) : 0;
  await new Promise<void>((resolve) => modelServer.listen(port, "0.0.0.0", resolve));
  modelPort = (modelServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
});

test("settings and every settings screen", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  await seed(request);
  const provider = await addModelProvider(request);
  const audits: Audit[] = [];
  try {
    for (const size of PHONES) {
      audits.push(
        await onTouchScreen(browser, testInfo, size, async (audit) => {
          const { page } = audit;
          for (const [path, heading] of [
            ["/settings", "Settings"],
            ["/settings/account", "Your account"],
            ["/settings/appearance", "Appearance"],
            ["/settings/offline", "Offline copy"],
            ["/settings/household", "Household"],
            ["/settings/members", "Members & invitations"],
            ["/settings/services", "AI and online services"],
            ["/settings/system-status", "System status"],
            ["/settings/advanced", "Advanced"],
            ["/settings/ai", "AI providers"],
          ] as const) {
            await page.goto(path);
            await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
            await page.waitForLoadState("networkidle");
            if (path === "/settings/ai") await expectChosenModel(page);
            await audit.check(path);
          }

          // Still on AI providers: the task rows, the provider dialog and a model picker.
          await aiSettingsParts(audit, "/settings/ai");
          await open(page.getByRole("button", { name: "Add provider" }));
          await expect(page.getByRole("dialog").getByRole("heading", { name: "Add provider" })).toBeVisible();
          await audit.check("/settings/ai, add provider dialog");
          await closeDialog(page);

          await page.goto("/settings/services");
          const lookups = page.locator("#online-search");
          for (const part of ["Online manual search", "Reference-image search", "Brave Search connection"]) {
            await open(lookups.getByRole("heading", { name: part }));
          }
          await audit.check("/settings/services, online lookups open");

          await page.goto("/settings/household");
          await open(main(page).getByRole("button", { name: "Switch household" }));
          await expect(page.getByRole("menu")).toBeVisible();
          await audit.check("/settings/household, household menu");
          await page.getByText("Create household", { exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Create a household" })).toBeVisible();
          await audit.check("/settings/household, create household dialog");
          await closeDialog(page);

          await page.goto("/settings/advanced");
          await audit.check("/settings/advanced");
        }),
      );
    }
  } finally {
    await request.delete(`/api/v1/ai/providers/${provider.id}`);
  }
  await report(testInfo, audits);
});

test("the shell: bar, rail, Add items, the assistant, menus and messages", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(browser, testInfo, size, async (audit) => {
        const { page } = audit;
        const bar = page.getByTestId("bottom-bar");
        const rail = page.getByTestId("room-rail");
        const field = bar.getByRole("combobox", { name: "Search or ask about your inventory" });
        await page.goto("/items");
        await expect(rail).toBeVisible();
        await audit.check("shell, rail and bar");
        await rail.getByRole("button", { name: "More", exact: true }).click();
        await expect(rail.getByTestId("rail-more")).toBeVisible();
        await audit.check("shell, More rolled up");
        await rail.getByRole("button", { name: "Close", exact: true }).click();
        await bar.getByRole("button", { name: "Hide rooms" }).click();
        await audit.check("shell, rail hidden");
        await bar.getByRole("button", { name: "Show rooms" }).click();

        await field.tap();
        await audit.check("shell, field in use");
        await field.fill("Touch");
        await expect(page.getByRole("listbox", { name: "Quick search results" })).toBeVisible();
        await audit.check("shell, quick matches");
        await bar.getByRole("button", { name: "Clear search" }).click();
        await page.keyboard.press("Escape");

        await page.goto(`/items/${data.itemId}`);
        await expect(page.getByTestId("quick-search-context")).toBeVisible();
        await audit.check("shell, bar with the This item chip");

        await page.goto("/items");
        await bar.getByRole("button", { name: "Add items" }).click();
        const add = page.getByRole("dialog", { name: "Add items" });
        await expect(add).toBeVisible();
        await audit.check("Add items");
        await add.getByRole("button", { name: /^Place:/ }).click();
        await audit.check("Add items, place open");
        await page.keyboard.press("Escape");
        if (await add.isVisible()) await closeDialog(page);

        await bar.locator('button[title="Open assistant"]').click();
        const assistant = page.getByTestId("assistant-panel");
        await expect(assistant.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
        await audit.check("assistant, empty");
        await assistant.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill(`Where is my ${data.itemName}?`);
        await assistant.getByRole("button", { name: "Send question", exact: true }).click();
        await expect(assistant.getByRole("button", { name: "Copy answer" })).toBeVisible();
        await audit.check("assistant, with a conversation");
        await open(assistant.getByText(/^Sources \(\d+\)/));
        await audit.check("assistant, sources open");
        // Below 380 px the header has no room for the full-height button, so it is not shown there.
        const tall = assistant.getByRole("button", { name: "Make the assistant full height" });
        if (size.width >= 380) {
          await tall.click();
          await audit.check("assistant, full height");
        } else {
          await expect(tall).toBeHidden();
        }
        await assistant.getByRole("button", { name: "Close assistant", exact: true }).click();

        // A message with an action: dismiss a capture review from the Review page.
        await page.goto("/review");
        const dismiss = page.getByRole("region", { name: "Pending captures" }).getByRole("button", { name: /^Dismiss/ });
        await expect(dismiss.first()).toBeVisible();
        await dismiss.first().click();
        await expect(page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" })).toBeVisible();
        await audit.check("a message with an action");
        await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();

        // A confirmation.
        await page.goto("/documents");
        await open(page.getByRole("button", { name: /^Options for Touch receipt/ }));
        await page.getByRole("menuitem", { name: /^Delete/ }).click();
        await expect(page.getByRole("dialog", { name: "Delete this document?" })).toBeVisible();
        await audit.check("a confirmation");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();

        await page.goto("/this-page-does-not-exist");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit.check("page not found");
      }),
    );
  }

  // A second property, so the rail and the sidebar show the property menu.
  const property = await post<{ id: string }>(request, "/api/v1/properties", { name: `Touch cabin ${Date.now()}` });
  try {
    audits.push(
      await onTouchScreen(browser, testInfo, PHONES[0]!, async (audit) => {
        const { page } = audit;
        await page.goto("/items");
        await page.getByTestId("room-rail").getByRole("button", { name: /^Property:/ }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("shell, property menu");
        await page.keyboard.press("Escape");
      }),
    );
  } finally {
    await request.delete(`/api/v1/properties/${property.id}`);
  }
  await report(testInfo, audits);
});

test("a touch tablet held sideways: the sidebar, its menus and every main page", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const data = await seed(request);
  const audits: Audit[] = [];
  // A second property, so the sidebar shows the property menu.
  const property = await post<{ id: string }>(request, "/api/v1/properties", { name: `Touch cabin ${Date.now()}` });
  const provider = await addModelProvider(request);
  try {
    audits.push(
      await onTouchScreen(browser, testInfo, TABLET, async (audit) => {
        const { page } = audit;
        const sidebar = page.locator("aside").first();
        await page.goto("/items");
        await expect(sidebar.getByRole("navigation", { name: "Rooms" })).toBeVisible();
        await audit.check("tablet, sidebar and item list");
        await sidebar.getByRole("button", { name: "More", exact: true }).click();
        await audit.check("tablet, sidebar More rolled up");
        await sidebar.getByRole("button", { name: "Close", exact: true }).click();
        await sidebar.getByRole("button", { name: /^Property:/ }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("tablet, property menu");
        await page.keyboard.press("Escape");
        await sidebar.getByRole("button", { name: "Account menu" }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("tablet, account menu");
        await page.keyboard.press("Escape");
        await sidebar.getByRole("button", { name: "Switch household" }).click();
        await expect(page.getByRole("menu")).toBeVisible();
        await audit.check("tablet, household menu");
        await page.keyboard.press("Escape");
        await page.locator('button[title="Open assistant"]').first().click();
        await expect(page.getByTestId("assistant-panel")).toBeVisible();
        await audit.check("tablet, assistant box");
        await page.getByRole("button", { name: "Close assistant", exact: true }).click();
        await page.goto(`/items/${data.itemId}`);
        await expect(page.getByRole("heading", { name: data.itemName, level: 1 })).toBeVisible();
        await audit.check("tablet, item page");
        await open(page.getByRole("tab", { name: /^Documents/ }));
        await audit.check("tablet, item page, Documents tab");

        // Controls that are small on a wide screen for a mouse must stay 44 px for a finger.
        await page.goto("/items");
        await open(main(page).getByRole("button", { name: /^Select/ }));
        await page.getByRole("checkbox", { name: new RegExp(`Select ${data.itemName}`) }).first().check();
        await open(main(page).getByRole("button", { name: "Filters" }));
        await audit.check("tablet, /items Select mode, Filters open");
        for (const path of [
          `/items/${data.itemId}/edit`,
          "/rooms",
          `/rooms/${data.roomId}`,
          "/containers",
          `/containers/${data.containerId}`,
          `/labels?ids=${data.containerId}`,
          "/loans",
          `/loans/${data.loanId}`,
          "/documents",
          `/documents/${data.documentId}`,
          "/purchases",
          "/warranties",
          "/insurance",
          "/stocktake",
          `/stocktake/${data.stocktakeId}`,
          "/review",
          "/imports",
          `/imports/${data.importId}`,
          "/settings",
          "/settings/account",
          "/settings/appearance",
          "/settings/offline",
          "/settings/household",
          "/settings/members",
          "/settings/services",
          "/settings/system-status",
          "/settings/advanced",
          "/settings/ai",
        ]) {
          await page.goto(path);
          await expect(page.locator("main h1").first()).toBeVisible();
          await page.waitForLoadState("networkidle");
          if (path === "/rooms") await expectNestedRooms(page, data);
          if (path === "/warranties") {
            await expect(main(page).getByRole("link", { name: data.documentTitle })).toBeVisible();
          }
          if (path === "/settings/ai") await expectChosenModel(page);
          await audit.check(`tablet, ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ":id").replace(/\?.*/, "")}`);
        }
        await aiSettingsParts(audit, "tablet, /settings/ai");
      }),
    );
  } finally {
    await request.delete(`/api/v1/ai/providers/${provider.id}`);
    await request.delete(`/api/v1/properties/${property.id}`);
  }
  await report(testInfo, audits);
});

test("signed-out pages: sign in, setup, password recovery, invitation and no household", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const audits: Audit[] = [];
  for (const size of PHONES) {
    audits.push(
      await onTouchScreen(
        browser,
        testInfo,
        size,
        async (audit) => {
          const { page } = audit;
          await page.goto("/login");
          await expect(page.getByLabel("Email")).toBeVisible();
          await audit.check("/login");
          await page.goto("/forgot-password");
          await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
          await audit.check("/forgot-password");
          await page.goto("/reset-password/not-a-real-reset-token");
          await expect(page.getByRole("heading", { name: "Reset link unavailable." })).toBeVisible();
          await audit.check("/reset-password, link unavailable");
          await page.goto("/invitations/not-a-real-invitation-token");
          await expect(page.getByRole("heading", { name: "Invitation unavailable." })).toBeVisible();
          await audit.check("/invitations, unavailable");

          // The forms behind a valid link, with the server's answers stood in.
          await page.route("**/api/v1/auth/password-reset/*", (route) =>
            route.request().method() === "GET"
              ? route.fulfill({ json: { valid: true, expires_at: "2027-12-01T00:00:00Z" } })
              : route.fallback(),
          );
          await page.route("**/api/v1/invitations/touch-audit-token", (route) =>
            route.fulfill({
              json: {
                household_name: "Touch household",
                email: "invited@example.com",
                role: "member",
                expires_at: "2027-12-01T00:00:00Z",
                account_exists: false,
                authenticated_email_matches: false,
              },
            }),
          );
          await page.goto("/invitations/touch-audit-token");
          await expect(page.getByLabel("Choose a password")).toBeVisible();
          await audit.check("/invitations, new account form");
          await page.goto("/reset-password/touch-audit-token");
          await expect(page.getByRole("button", { name: /password/i }).last()).toBeVisible();
          await expect(page.getByRole("heading", { name: "Reset link unavailable." })).toHaveCount(0);
          await audit.check("/reset-password, new password form");

          // First run: the server says no account exists yet.
          await page.route("**/api/v1/auth/session", (route) =>
            route.fulfill({
              json: { authenticated: false, setup_required: true, user: null, household: null, role: null, households: [] },
            }),
          );
          await page.goto("/setup");
          await expect(page.getByLabel("Email")).toBeVisible();
          await audit.check("/setup");

          // Signed in, but a member of no household.
          await page.unroute("**/api/v1/auth/session");
          await page.route("**/api/v1/auth/session", (route) =>
            route.fulfill({
              json: {
                authenticated: true,
                setup_required: false,
                user: { id: "touch-user", name: "Touch Person", email: "person@example.com", created_at: "2026-01-01T00:00:00Z" },
                household: null,
                role: null,
                households: [],
              },
            }),
          );
          await page.goto("/");
          await expect(page.getByRole("button", { name: /Create (a )?household/ }).first()).toBeVisible();
          await audit.check("no household");
        },
        { signedOut: true },
      ),
    );
  }
  await report(testInfo, audits);
});
