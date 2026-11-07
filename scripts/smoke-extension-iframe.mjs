import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOpenPencilClipboard } from "@open-pencil/core";
import { chromium } from "playwright";

const extensionPath = new URL("../dist/extension/", import.meta.url).pathname;
const childServer = Bun.serve({
  port:0,
  fetch() {
    return new Response(`<!doctype html><html><body style="margin:40px;font:16px sans-serif">
      <article id="payout" style="width:420px;padding:24px;border:1px solid #d6d3d1;border-radius:12px">
        <h2 style="margin:0 0 8px">Payout Threshold</h2>
        <p style="margin:0">Set the minimum balance required before a payout is triggered.</p>
        <closed-note></closed-note>
      </article>
      <script>
        customElements.define("closed-note", class extends HTMLElement {
          constructor() { super(); this.attachShadow({mode:"closed"}).innerHTML = "<p style='margin:8px 0 0'>Inside a closed shadow root</p>"; }
        });
      </script>
    </body></html>`, {headers:{"content-type":"text/html"}});
  },
});
const childOrigin = `http://127.0.0.1:${childServer.port}`;
let secretReads = 0;
const secretServer = Bun.serve({
  port:0,
  fetch() {
    secretReads += 1;
    return new Response("secret", {headers:{"content-type":"text/plain"}});
  },
});
const secretUrl = `http://localhost:${secretServer.port}/secret`;
const topServer = Bun.serve({
  port:0,
  fetch() {
    return new Response(`<!doctype html><html><body style="margin:0"><iframe src="${childOrigin}" style="width:800px;height:500px;border:0"></iframe></body></html>`, {headers:{"content-type":"text/html"}});
  },
});
const topOrigin = `http://127.0.0.1:${topServer.port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openpencil-capture-chrome-"));
let context;

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel:"chromium",
    headless:true,
    args:[`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin:topOrigin});
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {timeout:15_000});
  const page = context.pages()[0] || await context.newPage();
  await page.goto(topOrigin, {waitUntil:"networkidle"});
  const frame = page.frames().find((candidate) => candidate.url().startsWith(childOrigin));
  if (!frame) throw new Error("Could not find the extension iframe fixture");

  const clickToolbarButton = () => serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab?.id) throw new Error("Could not resolve the active test tab");
    await globalThis.openPencilToggleCapture(tab.id);
  });
  const pickerViews = () => Promise.all(page.frames().map((candidate) => candidate.evaluate(() => {
    const host = document.getElementById("__openpencil_capture_host__");
    if (!host) return "closed";
    return ["selection", "capturing", "success"].find((name) => !host.shadowRoot.querySelector(`.${name}-view`).hidden);
  })));
  await clickToolbarButton();

  // A hostile page tries every channel an earlier design exposed to page scripts.
  const pageChannels = await page.evaluate(async (url) => {
    const replies = [];
    const id = crypto.randomUUID();
    for (const name of ["asset-response", "copy-response"]) {
      addEventListener(`openpencil-capture:${name}`, (event) => replies.push(event.detail));
    }
    dispatchEvent(new CustomEvent("openpencil-capture:asset-request", {detail:JSON.stringify({id, url})}));
    dispatchEvent(new CustomEvent("openpencil-capture:copy-request", {detail:JSON.stringify({id, selector:"body"})}));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      replies,
      marker:document.documentElement.hasAttribute("data-openpencil-capture-extension"),
      runtime:typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage),
    };
  }, secretUrl);
  if (secretReads !== 0 || pageChannels.replies.length > 0 || pageChannels.marker || pageChannels.runtime) {
    throw new Error(`The page reached the extension: ${JSON.stringify({secretReads, pageChannels})}`);
  }

  // Scripted input must not stand in for the user: no capture may start from it.
  await page.mouse.move(5, 5);
  const scriptedCapture = await page.evaluate(async () => {
    document.body.click();
    for (const init of [{key:"Enter"}, {key:"Enter", metaKey:true}, {key:"Enter", ctrlKey:true}]) {
      document.dispatchEvent(new KeyboardEvent("keydown", {bubbles:true, ...init}));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const view = (name) => !document.getElementById("__openpencil_capture_host__").shadowRoot.querySelector(name).hidden;
    return {capturing:view(".capturing-view"), success:view(".success-view"), selecting:view(".selection-view")};
  });
  if (scriptedCapture.capturing || scriptedCapture.success || !scriptedCapture.selecting) {
    throw new Error(`Page scripts started a capture: ${JSON.stringify(scriptedCapture)}`);
  }

  const target = frame.locator("#payout");
  await frame.locator("#__openpencil_capture_host__").waitFor({state:"attached"});
  // The card's own padding, below the toolbar, so the whole card is the selection.
  const bounds = await target.boundingBox();
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height - 10);
  await page.mouse.click(bounds.x + 10, bounds.y + bounds.height - 10);
  try {
    await frame.waitForFunction(() => {
      const host = document.getElementById("__openpencil_capture_host__");
      return host && !host.shadowRoot.querySelector(".success-view").hidden;
    }, null, {timeout:30_000});
  } catch {
    const state = await frame.locator("#__openpencil_capture_host__").evaluate((host) => ({
      capturing:!host.shadowRoot.querySelector(".capturing-view").hidden,
      message:host.shadowRoot.querySelector(".capturing-message").textContent,
      progress:host.shadowRoot.querySelector(".capture-progress").getAttribute("aria-valuenow"),
    }));
    throw new Error(`Loaded extension capture did not complete: ${JSON.stringify(state)}`);
  }

  const plain = await page.evaluate(() => navigator.clipboard.readText());
  const payload = parseOpenPencilClipboard(plain);
  const texts = [];
  const collect = (node) => { if (node.type === "TEXT") texts.push(node.text); node.children?.forEach(collect); };
  payload?.nodes.forEach(collect);
  const clipboard = {marker:Boolean(payload), name:payload?.nodes[0]?.name, closedShadow:texts.includes("Inside a closed shadow root")};
  if (!clipboard.marker || !clipboard.name?.includes("Payout Threshold")) {
    throw new Error(`Loaded extension did not copy the iframe selection: ${JSON.stringify(clipboard)}`);
  }
  const outline = (node, depth = 0) => [`${" ".repeat(depth)}${node.type} ${node.name} ${node.text ?? ""}`, ...(node.children || []).flatMap((child) => outline(child, depth + 1))];
  if (!clipboard.closedShadow) throw new Error(`The capture left out a closed shadow root:\n${payload.nodes.flatMap((node) => outline(node)).join("\n")}`);
  // Esc in a frame closes the picker in every frame, and the button opens them again.
  await clickToolbarButton();
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height - 10);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const escaped = await pickerViews();
  if (escaped.some((view) => view !== "closed")) throw new Error(`Esc left pickers open: ${JSON.stringify(escaped)}`);

  // Clicking the button while one frame shows its success message starts over in every frame.
  await clickToolbarButton();
  const reopened = await pickerViews();
  if (reopened.some((view) => view !== "selection")) throw new Error(`The button left frames out of sync: ${JSON.stringify(reopened)}`);

  // Regression: during the top frame's success message, a click closed the top picker and opened
  // invisible ones in the iframes.
  await page.mouse.move(1000, 650);
  await page.mouse.click(1000, 650);
  await page.waitForFunction(() => {
    const host = document.getElementById("__openpencil_capture_host__");
    return host && !host.shadowRoot.querySelector(".success-view").hidden;
  }, null, {timeout:30_000});
  await clickToolbarButton();
  const closed = await pickerViews();
  if (closed.some((view) => view !== "closed")) throw new Error(`The button left pickers open: ${JSON.stringify(closed)}`);
  console.log(JSON.stringify({loadedExtension:true, crossOrigin:true, clipboard, escaped, reopened, closed}));
} finally {
  await context?.close();
  topServer.stop(true);
  childServer.stop(true);
  secretServer.stop(true);
  await rm(userDataDir, {recursive:true, force:true});
}
