import { parseOpenPencilClipboard } from "@open-pencil/core";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const childServer = Bun.serve({
  port:0,
  fetch() {
    return new Response(`<!doctype html><html><body style="margin:40px;background:#f5f5f4;font:16px sans-serif">
      <article id="payout" style="width:420px;padding:24px;border:1px solid #d6d3d1;border-radius:12px;background:white">
        <h2 style="margin:0 0 8px">Payout Threshold</h2>
        <p style="margin:0;color:#78716c">Set the minimum balance required before a payout is triggered.</p>
      </article>
    </body></html>`, {headers:{"content-type":"text/html"}});
  },
});
const childOrigin = `http://127.0.0.1:${childServer.port}`;
const topServer = Bun.serve({
  port:0,
  fetch() {
    return new Response(`<!doctype html><html><body style="margin:0"><iframe title="Preview" src="${childOrigin}" style="width:800px;height:500px;border:0"></iframe></body></html>`, {headers:{"content-type":"text/html"}});
  },
});
const topOrigin = `http://127.0.0.1:${topServer.port}`;
const browser = await chromium.launch({headless:true});

try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin:topOrigin});
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin:childOrigin});
  const page = await context.newPage();
  await page.goto(topOrigin, {waitUntil:"networkidle", timeout:30_000});
  await page.addScriptTag({path:new URL("dist/extension/bridge.js", root).pathname});
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "chrome", {
      configurable:true,
      value:{runtime:{
        getURL:(path) => `https://extension.invalid/${path}`,
        sendMessage:async (message) => ({ok:true, finalUrl:message.url, dataUrl:null}),
      }},
    });
  });
  await page.addScriptTag({path:new URL("dist/extension/content.js", root).pathname});
  const frame = page.frames().find((candidate) => candidate.url().startsWith(childOrigin));
  if (!frame) throw new Error("Could not find the cross-origin iframe fixture");

  const target = frame.locator("#payout");
  await target.waitFor({state:"visible"});
  await frame.addScriptTag({path:new URL("dist/extension/bridge.js", root).pathname});
  await frame.evaluate(() => {
    Object.defineProperty(globalThis, "chrome", {
      configurable:true,
      value:{runtime:{
        getURL:(path) => `https://extension.invalid/${path}`,
        sendMessage:async (message) => {
          if (message.type === "openpencil-capture:write-clipboard") {
            globalThis.__openPencilCaptureTestClipboard = message;
            return {ok:true};
          }
          return {ok:false, error:"The iframe fixture has no assets"};
        },
      }},
    });
  });
  await frame.addScriptTag({path:new URL("dist/extension/content.js", root).pathname});

  const toolbar = await frame.locator("#__openpencil_capture_host__").evaluateHandle((host) => host.shadowRoot.querySelector(".toolbar"));
  const topToolbar = await page.locator("#__openpencil_capture_host__").evaluateHandle((host) => host.shadowRoot.querySelector(".toolbar"));
  if (!await toolbar.evaluate((element) => element.classList.contains("frame-inactive"))) {
    throw new Error("Embedded picker should stay hidden until the pointer enters its document");
  }

  await target.hover({position:{x:40, y:40}});
  if (await toolbar.evaluate((element) => element.classList.contains("frame-inactive"))) {
    throw new Error("Embedded picker did not activate when the pointer entered its document");
  }
  if (!await topToolbar.evaluate((element) => element.classList.contains("frame-inactive"))) {
    throw new Error("Top-level picker stayed visible while the embedded picker was active");
  }
  await target.click({position:{x:40, y:40}});

  await frame.waitForFunction(() => {
    const host = document.getElementById("__openpencil_capture_host__");
    return host && !host.shadowRoot.querySelector(".success-view").hidden;
  }, null, {timeout:30_000});

  const payload = parseOpenPencilClipboard(await frame.evaluate(() => globalThis.__openPencilCaptureTestClipboard?.html || ""));
  const clipboard = {marker:Boolean(payload), name:payload?.nodes[0]?.name};
  if (!clipboard.marker || !clipboard.name?.includes("Payout Threshold")) {
    throw new Error(`Iframe selection did not reach OpenPencil's clipboard: ${JSON.stringify(clipboard)}`);
  }

  console.log(JSON.stringify({topOrigin, childOrigin, crossOrigin:true, clipboard}));
} finally {
  await browser.close();
  topServer.stop(true);
  childServer.stop(true);
}
