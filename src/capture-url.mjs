import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function captureBundle() {
  const source = await readFile(resolve(moduleDir, "capture-element.mjs"), "utf8");
  if (/^\s*import\s/m.test(source)) throw new Error("capture-element.mjs must remain self-contained for browser injection");
  return `${source.replace(/\bexport\s+/g, "")}\n;globalThis.OpenPencilCapture={captureElement};\n`;
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
    const capture = await target.evaluate((element, captureOptions) => {
      return globalThis.OpenPencilCapture.captureElement(element, captureOptions);
    }, {url, selector, label: options.label ?? null, capturedAt});
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
