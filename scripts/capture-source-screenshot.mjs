import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const [url, selector, outputPath] = process.argv.slice(2);
if (!url || !selector || !outputPath) {
  console.error("Usage: bun scripts/capture-source-screenshot.mjs <url> <selector> <output.png>");
  process.exit(2);
}

const output = resolve(outputPath);
const settleMs = Number.parseInt(process.env.OPENPENCIL_CAPTURE_SETTLE_MS ?? "500", 10);
if (!Number.isFinite(settleMs) || settleMs < 0) {
  throw new Error("OPENPENCIL_CAPTURE_SETTLE_MS must be a non-negative integer");
}
await mkdir(dirname(output), {recursive:true});
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({
    deviceScaleFactor:1,
    viewport:{width:1280,height:960},
    reducedMotion:"reduce",
  });
  await page.goto(url, {waitUntil:"networkidle",timeout:60_000});
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  const target = page.locator(selector);
  await target.waitFor({state:"visible",timeout:30_000});
  const initialBox = await target.boundingBox();
  if (!initialBox) throw new Error(`Target has no bounding box: ${selector}`);
  await page.setViewportSize({
    width:Math.max(1280,Math.ceil(initialBox.x + initialBox.width)),
    height:Math.max(960,Math.ceil(initialBox.y + initialBox.height)),
  });
  await page.waitForTimeout(settleMs);
  await target.screenshot({path:output,animations:"disabled"});
  const box = await target.boundingBox();
  console.log(JSON.stringify({url,selector,output,width:box?.width,height:box?.height,settleMs}));
} finally {
  await browser.close();
}
