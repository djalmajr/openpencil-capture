// Draws the Chrome Web Store images from the real extension: the picker on a page, the same card
// pasted into OpenPencil and rendered by its engine, and the small promotional tile. Run after
// `bun run build`; writes store/*.png.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessRenderNodes } from "@open-pencil/core";
import { createEditor } from "@open-pencil/core/editor";
import { chromium } from "playwright";

const extensionPath = new URL("../dist/extension/", import.meta.url).pathname;
const output = new URL("../store/", import.meta.url).pathname;
const fonts = new URL("../node_modules/@open-pencil/core/assets/", import.meta.url).pathname;
const icon = new URL("../extension/icons/icon-128.png", import.meta.url).pathname;

const fontFaces = [[400, "Regular"], [500, "Medium"], [600, "SemiBold"], [700, "Bold"]]
  .map(([weight, name]) => `@font-face { font-family:Inter; font-weight:${weight}; src:url(/fonts/Inter-${name}.ttf); }`).join("\n");

// A dashboard card with what the capture keeps editable: gradients, a chart, text, controls.
const demo = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  ${fontFaces}
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#F5F5F4; font:14px/20px Inter, sans-serif; color:#1C1917; }
  #target { width:560px; padding:24px; box-sizing:border-box; background:#fff; border:1px solid #D6D3D1; border-radius:16px; box-shadow:0 8px 24px rgba(28,25,23,.14); display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
  h2 { grid-column:1/-1; margin:0; font-size:22px; line-height:30px; font-weight:700; letter-spacing:-.4px; }
  .stat { padding:12px; border-radius:12px; color:#fff; }
  .stat b { display:block; font-size:20px; line-height:28px; }
  .a { background:linear-gradient(135deg,#F59E0B,#E11D48); } .b { background:linear-gradient(135deg,#0EA5E9,#6366F1); } .c { background:linear-gradient(135deg,#22C55E,#0F766E); }
  .chart { grid-column:1/-1; height:120px; border-radius:12px; background:#FAFAF9; overflow:hidden; }
  p { grid-column:1/-1; margin:0; color:#57534E; }
  .row { grid-column:1/-1; display:flex; gap:8px; }
  input { flex:1; height:36px; padding:0 12px; border:1px solid #D6D3D1; border-radius:8px; font:14px/20px Inter, sans-serif; }
  button { height:36px; padding:0 16px; border:0; border-radius:8px; background:#1C1917; color:#fff; font:600 14px/20px Inter, sans-serif; }
</style></head><body>
  <section id="target">
    <h2>Payout overview</h2>
    <div class="stat a">Pending<b>$4,210</b></div><div class="stat b">Scheduled<b>$12,880</b></div><div class="stat c">Paid<b>$98,302</b></div>
    <div class="chart"><svg width="100%" height="100%" viewBox="0 0 200 60" preserveAspectRatio="none">
      <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366F1" stop-opacity=".5"/><stop offset="1" stop-color="#6366F1" stop-opacity="0"/></linearGradient></defs>
      <path d="M0 50 C30 10 60 45 100 25 S170 10 200 18 V60 H0 Z" fill="url(#area)"/>
      <path d="M0 50 C30 10 60 45 100 25 S170 10 200 18" fill="none" stroke="#4F46E5" stroke-width="1.5"/>
    </svg></div>
    <p>Set the minimum balance required before a payout is triggered.</p>
    <div class="row"><input placeholder="Minimum balance"><button>Save changes</button></div>
  </section>
</body></html>`;

const frame = (title, image, width, height) => `<figure style="margin:0;display:grid;gap:14px;justify-items:center">
  <figcaption style="font:600 16px/24px Inter, sans-serif;color:#44403C">${title}</figcaption>
  <img src="data:image/png;base64,${Buffer.from(image).toString("base64")}" width="${width}" height="${height}" style="border-radius:16px;box-shadow:0 8px 24px rgba(28,25,23,.12)">
</figure>`;

const server = Bun.serve({
  port:0,
  fetch(request) {
    const {pathname} = new URL(request.url);
    if (pathname.startsWith("/fonts/")) return new Response(Bun.file(`${fonts}${pathname.slice(7)}`));
    if (pathname === "/icon.png") return new Response(Bun.file(icon));
    return new Response(demo, {headers:{"content-type":"text/html"}});
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openpencil-capture-store-"));
let context;

try {
  await mkdir(output, {recursive:true});
  context = await chromium.launchPersistentContext(userDataDir, {
    channel:"chromium", headless:true, viewport:{width:1280, height:800}, deviceScaleFactor:1,
    args:[`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin});
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {timeout:15_000});
  const tab = context.pages()[0] || await context.newPage();
  await tab.goto(origin, {waitUntil:"networkidle"});
  await tab.evaluate(async () => {
    await Promise.all(["400 14px Inter", "600 14px Inter", "700 22px Inter"].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  });
  const target = tab.locator("#target");
  const source = await target.screenshot({animations:"disabled"});

  // 1. The picker over the card, as the user sees it before clicking.
  await worker.evaluate(async () => {
    const [active] = await chrome.tabs.query({active:true, currentWindow:true});
    await globalThis.openPencilToggleCapture(active.id);
  });
  await tab.locator("#__openpencil_capture_host__").waitFor({state:"attached"});
  const box = await target.boundingBox();
  await tab.mouse.move(box.x + 8, box.y + box.height - 8);
  await tab.waitForTimeout(400);
  await writeFile(`${output}screenshot-1-picker.png`, await tab.screenshot());

  // 2. The capture, pasted into the OpenPencil engine, next to the page.
  await tab.mouse.click(box.x + 8, box.y + box.height - 8);
  await tab.waitForFunction(() => {
    const host = document.getElementById("__openpencil_capture_host__");
    return host && !host.shadowRoot.querySelector(".success-view").hidden;
  }, null, {timeout:60_000});
  const envelope = await tab.evaluate(() => navigator.clipboard.readText());
  const editor = createEditor();
  const pageId = editor.state.currentPageId;
  await editor.pasteFromHTML(envelope);
  const [root] = editor.graph.getChildren(pageId);
  editor.graph.updateNode(root.id, {effects:[]});
  const pasted = await headlessRenderNodes(editor.graph, pageId, [root.id], {scale:1, format:"PNG"});
  const side = await context.newPage();
  await side.setViewportSize({width:1280, height:800});
  await side.setContent(`<!doctype html><html><head><style>${fontFaces.replaceAll("url(/", `url(${origin}/`)}</style></head>
    <body style="margin:0;width:1280px;height:800px;display:grid;grid-template-columns:1fr 1fr;align-items:center;justify-items:center;background:linear-gradient(180deg,#FAFAF9,#E7E5E4)">
    ${frame("In the browser", source, Math.round(box.width), Math.round(box.height))}
    ${frame("Pasted in OpenPencil, as editable layers", pasted, Math.round(box.width), Math.round(box.height))}</body></html>`, {waitUntil:"load"});
  await side.evaluate(() => document.fonts.ready);
  await writeFile(`${output}screenshot-2-result.png`, await side.screenshot());

  // 3. The small promotional tile.
  await side.setViewportSize({width:440, height:280});
  await side.setContent(`<!doctype html><html><head><style>${fontFaces.replaceAll("url(/", `url(${origin}/`)}</style></head>
    <body style="margin:0;width:440px;height:280px;display:grid;place-items:center;background:linear-gradient(135deg,#1C1917,#44403C);font-family:Inter, sans-serif;color:#fff">
    <div style="display:grid;justify-items:center;gap:14px;text-align:center">
      <img src="${origin}/icon.png" width="80" height="80">
      <div style="font-weight:700;font-size:28px;line-height:34px;letter-spacing:-.5px">OpenPencil Capture</div>
      <div style="font-size:15px;line-height:22px;color:#D6D3D1">Copy any web element as editable layers</div>
    </div></body></html>`, {waitUntil:"load"});
  await side.evaluate(() => document.fonts.ready);
  await writeFile(`${output}promo-small-440x280.png`, await side.screenshot());
  console.log(JSON.stringify({output, files:["screenshot-1-picker.png", "screenshot-2-result.png", "promo-small-440x280.png"]}));
} finally {
  await context?.close();
  server.stop(true);
  await rm(userDataDir, {recursive:true, force:true});
}
