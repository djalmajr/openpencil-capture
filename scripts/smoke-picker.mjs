import { parseOpenPencilClipboard } from "@open-pencil/core";
import { chromium } from "playwright";

const url = process.argv[2] || "https://ui.shadcn.com/preview/base/preview-02?preset=b1FS9AzhY&theme=amber&chartColor=amber&font=noto-sans&baseColor=olive&radius=small&template=vite&pointer=true";
const targetSelector = process.argv[3] || "div.relative.bg-background > div.overflow-x-auto.overflow-y-hidden > div.flex.w-full > div.grid.grid-cols-7";
const root = new URL("../", import.meta.url);
const browser = await chromium.launch({ headless:true });
try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin:new URL(url).origin });
  const page = await context.newPage();
  await page.goto(url, { waitUntil:"networkidle", timeout:60_000 });
  await page.locator(targetSelector).waitFor({ state:"visible", timeout:30_000 });
  await page.addScriptTag({ path:new URL("dist/extension/bridge.js", root).pathname });
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "chrome", {
      configurable:true,
      value:{ runtime:{
        getURL:(path) => `https://extension.invalid/${path}`,
        sendMessage:async (message) => {
          if (message.type === "openpencil-capture:write-clipboard") {
            globalThis.__openPencilCaptureTestClipboard = message;
            return {ok:true};
          }
          return {ok:false,error:"Assets are fetched by the page in this smoke"};
        },
      } },
    });
  });
  await page.addScriptTag({ path:new URL("dist/extension/content.js", root).pathname });

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("__openpencil_capture_host__"));
  await page.addScriptTag({ path:new URL("dist/extension/content.js", root).pathname });
  if (await page.locator("#__openpencil_capture_host__").count() !== 1) {
    throw new Error("Picker did not reopen after Escape teardown");
  }

  const target = page.locator(targetSelector);
  const box = await target.boundingBox();
  if (!box) throw new Error("Target has no visible bounding box");
  const pointer = {
    x:box.x + Math.min(40, box.width / 2),
    y:box.y + Math.min(40, box.height / 2),
  };
  await page.mouse.move(pointer.x, pointer.y);
  const selectedBox = await page.evaluate(({ x, y }) => {
    const selected = document.elementFromPoint(x, y);
    if (!(selected instanceof Element)) return null;
    const rect = selected.getBoundingClientRect();
    selected.replaceWith(selected.cloneNode(true));
    return { width:rect.width, height:rect.height };
  },pointer);
  if (!selectedBox) throw new Error("Picker did not select a live element under the pointer");
  await page.mouse.click(pointer.x, pointer.y);

  const state = async () => page.locator("#__openpencil_capture_host__").evaluate((host) => {
    const toolbar = host.shadowRoot.querySelector(".toolbar");
    const progressElement = host.shadowRoot.querySelector(".capture-progress");
    const toolbarWidth = toolbar.getBoundingClientRect().width;
    return {
      selectionHidden:host.shadowRoot.querySelector(".selection-view").hidden,
      capturingHidden:host.shadowRoot.querySelector(".capturing-view").hidden,
      successHidden:host.shadowRoot.querySelector(".success-view").hidden,
      capturingText:host.shadowRoot.querySelector(".capturing-message").textContent,
      progress:Number(progressElement.getAttribute("aria-valuenow")),
      progressText:host.shadowRoot.querySelector(".capturing-percentage").textContent,
      progressVisible:toolbar.classList.contains("is-capturing"),
      progressFillRatio:toolbarWidth ? progressElement.getBoundingClientRect().width / toolbarWidth : 0,
    };
  });
  const capturing = await state();
  if (!capturing.selectionHidden || capturing.capturingHidden || !capturing.successHidden) {
    throw new Error(`Picker did not enter its exclusive capturing view: ${JSON.stringify(capturing)}`);
  }
  if (!capturing.progressVisible || capturing.progress < 1 || capturing.progress >= 100 || capturing.progressText !== `${capturing.progress}%`) {
    throw new Error(`Picker did not expose a truthful intermediate progress state: ${JSON.stringify(capturing)}`);
  }
  await page.waitForTimeout(200);
  const progressing = await state();
  if (progressing.progress <= capturing.progress || progressing.progressFillRatio <= 0 || Math.abs(progressing.progressFillRatio - progressing.progress / 100) > 0.08) {
    throw new Error(`Picker progress background did not visibly advance: ${JSON.stringify({ capturing, progressing })}`);
  }
  await page.waitForFunction(() => {
    const host = document.getElementById("__openpencil_capture_host__");
    return host && !host.shadowRoot.querySelector(".success-view").hidden;
  }, null, { timeout:60_000 });
  const success = await state();
  const html = await page.evaluate(() => globalThis.__openPencilCaptureTestClipboard?.html || "");
  const payload = parseOpenPencilClipboard(html);
  const clipboard = {
    marker:Boolean(payload),
    bytes:new Blob([html]).size,
    nodes:payload?.nodes.length || 0,
    images:payload?.images.size || 0,
    firstNodeType:payload?.nodes[0]?.type,
    rootWidth:payload?.nodes[0]?.width,
  };
  if (!success.selectionHidden || !success.capturingHidden || success.successHidden || !clipboard.marker) {
    throw new Error(`Picker did not finish in its exclusive success view: ${JSON.stringify({ success, clipboard })}`);
  }
  if (Math.abs(clipboard.rootWidth - selectedBox.width) > 1) {
    throw new Error(`Picker did not recover the replaced selected element: ${JSON.stringify({expectedWidth:selectedBox.width,clipboard})}`);
  }
  if (success.progress !== 100 || success.progressVisible) {
    throw new Error(`Picker did not complete and hide its progress background: ${JSON.stringify(success)}`);
  }
  console.log(JSON.stringify({ url, escapeClosed:true, reopened:true, clicked:true, capturing, progressing, success, clipboard }));
} finally {
  await browser.close();
}
