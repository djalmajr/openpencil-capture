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
      </article>
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

  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab?.id) throw new Error("Could not resolve the active test tab");
    const target = {tabId:tab.id, allFrames:true};
    await chrome.scripting.executeScript({target, files:["content.js"]});
  });

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

  const target = frame.locator("#payout");
  await frame.locator("#__openpencil_capture_host__").waitFor({state:"attached"});
  await target.hover({position:{x:40, y:40}});
  await target.click({position:{x:40, y:40}});
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
  const clipboard = {marker:Boolean(payload), name:payload?.nodes[0]?.name};
  if (!clipboard.marker || !clipboard.name?.includes("Payout Threshold")) {
    throw new Error(`Loaded extension did not copy the iframe selection: ${JSON.stringify(clipboard)}`);
  }
  console.log(JSON.stringify({loadedExtension:true, crossOrigin:true, clipboard}));
} finally {
  await context?.close();
  topServer.stop(true);
  childServer.stop(true);
  secretServer.stop(true);
  await rm(userDataDir, {recursive:true, force:true});
}
