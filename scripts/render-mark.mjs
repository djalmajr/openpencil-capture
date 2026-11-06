import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Rendered by a browser because ImageMagick's SVG renderer paints this artwork black.
const [source = "assets/brand/mark-micro.svg", output = "extension/icons/openpencil-mark.png", size = "80"] = process.argv.slice(2);
const svg = await readFile(source, "utf8");
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:Number(size), height:Number(size)}});
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
  await page.screenshot({path:output, omitBackground:true});
} finally {
  await browser.close();
}
