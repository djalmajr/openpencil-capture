import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { mergeFrameCapture } from "./capture-element.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export async function captureBundle() {
  const source = await readFile(resolve(moduleDir, "capture-element.mjs"), "utf8");
  if (/^\s*import\s/m.test(source)) throw new Error("capture-element.mjs must remain self-contained for browser injection");
  return `${source.replace(/\bexport\s+/g, "")}\n;globalThis.OpenPencilCapture={captureElement};\n`;
}

// In the page, the capture lists the frames of another origin it cannot read and keeps their
// elements, in that order, for this side to find them.
const captureIn = (handle, options) => handle.evaluate((element, captureOptions) => {
  globalThis.__openPencilFrameElements = [];
  const captureFrame = (frame) => {
    globalThis.__openPencilFrameElements.push(frame);
    return null;
  };
  return globalThis.OpenPencilCapture.captureElement(element, {...captureOptions, url:captureOptions.url || location.href, captureFrame});
}, options);

// Each frame of another origin is captured in its own document, Playwright reaching where the page
// cannot, and merged where its <iframe> shows it; frames inside it the same way.
async function fillFrames(owner, capture, script, depth = 0) {
  const requests = capture.frames || [];
  delete capture.frames;
  for (const [index, request] of requests.entries()) {
    try {
      const element = (await owner.evaluateHandle((at) => globalThis.__openPencilFrameElements?.[at] || null, index)).asElement();
      const frame = element && await element.contentFrame();
      if (!frame || depth > 8) continue;
      await frame.addScriptTag({content:script});
      const framed = await captureIn(await frame.evaluateHandle(() => document.documentElement), {frame:{clip:request.clip}, capturedAt:capture.capturedAt});
      await fillFrames(frame, framed, script, depth + 1);
      mergeFrameCapture(capture, request, framed);
    } catch {
      // A frame that navigated away or refuses scripts stays an empty frame.
    }
  }
  return capture;
}

/** Captures `locator`'s element, frames of other origins included. */
export async function captureTarget(locator, options, script) {
  const handle = await locator.elementHandle();
  const capture = await captureIn(handle, options);
  return fillFrames(await handle.ownerFrame(), capture, script);
}

export async function captureUrl(options) {
  const url = String(options.url ?? "");
  const selector = String(options.selector ?? "");
  const output = resolve(String(options.output ?? ""));
  if (!url) throw new Error("capture requires --url");
  if (!selector) throw new Error("capture requires --selector");
  if (!options.output) throw new Error("capture requires --output");
  const width = positiveInteger(options.width ?? 1280, "width");
  const height = positiveInteger(options.height ?? 960, "height");
  const settleMs = Number.parseInt(options["settle-ms"] ?? "500", 10);
  if (!Number.isFinite(settleMs) || settleMs < 0) throw new Error("settle-ms must be a non-negative integer");
  const screenshot = options.screenshot ? resolve(String(options.screenshot)) : null;
  const capturedAt = String(options["captured-at"] ?? "2026-07-20T12:00:00.000Z");
  const script = await captureBundle();
  await mkdir(dirname(output), {recursive: true});
  if (screenshot) await mkdir(dirname(screenshot), {recursive: true});
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({
      locale: String(options.locale ?? "en-US"),
      timezoneId: String(options.timezone ?? "UTC"),
      colorScheme: options.theme === "dark" ? "dark" : "light",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      viewport: {width, height}
    });
    const page = await context.newPage();
    await page.goto(url, {waitUntil: "networkidle", timeout: 60_000});
    await page.addStyleTag({content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}"});
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    const target = page.locator(selector).first();
    await target.waitFor({state: "visible", timeout: 30_000});
    await page.waitForTimeout(settleMs);
    await page.addScriptTag({content: script});
    const capture = await captureTarget(target, {url, selector, label: options.label ?? null, capturedAt}, script);
    capture.environment = {
      locale: String(options.locale ?? "en-US"),
      timezone: String(options.timezone ?? "UTC"),
      theme: options.theme === "dark" ? "dark" : "light",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      viewport: {width, height},
      settleMs
    };
    if (screenshot) await target.screenshot({path: screenshot, animations: "disabled"});
    await writeFile(output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
    return {output, screenshot, label: capture.label, nodes: capture.nodes.length, source: capture.source, environment: capture.environment};
  } finally {
    await browser.close();
  }
}
