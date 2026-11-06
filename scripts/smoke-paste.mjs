import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessRenderNodes, parseOpenPencilClipboard } from "@open-pencil/core";
import { createEditor } from "@open-pencil/core/editor";
import { chromium } from "playwright";

const extensionPath = new URL("../dist/extension/", import.meta.url).pathname;
const artifacts = new URL("../artifacts/smoke-paste/", import.meta.url).pathname;
const maxRmse = process.env.OPENPENCIL_CAPTURE_MAX_RMSE || "0.08";
// The hosted editor exercises the browser paste route with real code. Set it empty to stay offline.
const editorUrl = process.env.OPENPENCIL_CAPTURE_EDITOR_URL ?? "https://app.openpencil.dev/";

const magickPng = async (...args) => {
  const process = Bun.spawn(["magick", ...args, "png:-"], {stdout:"pipe"});
  return new Uint8Array(await new Response(process.stdout).arrayBuffer());
};
const png = await magickPng("-size", "96x96", "gradient:#E11D48-#2563EB");

// A second origin without CORS headers: only the extension's own fetch can read these.
const assets = Bun.serve({
  port:0,
  fetch(request) {
    const {pathname} = new URL(request.url);
    if (pathname === "/photo.png") return new Response(png, {headers:{"content-type":"image/png"}});
    if (pathname === "/logo.svg") {
      return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#16A34A"/><rect x="7" y="7" width="10" height="10" fill="#fff"/></svg>`, {headers:{"content-type":"image/svg+xml"}});
    }
    return new Response("not found", {status:404});
  },
});
const assetOrigin = `http://127.0.0.1:${assets.port}`;

const fontFaces = [[400, "Regular"], [500, "Medium"], [600, "SemiBold"], [700, "Bold"]]
  .map(([weight, name]) => `@font-face { font-family:Inter; font-weight:${weight}; src:url(/fonts/Inter-${name}.ttf); }`)
  .join("\n");

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  ${fontFaces}
  body { margin:0; padding:24px; background:#F5F5F4; font:14px/20px Inter, sans-serif; color:#1C1917; }
  #target { width:720px; padding:24px; box-sizing:border-box; background:#fff; border:1px solid #D6D3D1; border-radius:16px; box-shadow:0 8px 24px rgba(28,25,23,.18); display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
  h2 { grid-column:1/-1; margin:0; font-size:24px; line-height:32px; font-weight:700; letter-spacing:-.5px; }
  .tile { height:96px; border-radius:12px; overflow:hidden; position:relative; }
  .tile img, .tile canvas { display:block; width:100%; height:100%; object-fit:cover; }
  .gradient { background:linear-gradient(135deg,#F59E0B,#7C3AED); }
  .layered { background-color:#0EA5E9; background-image:linear-gradient(90deg,rgba(255,255,255,.7),rgba(255,255,255,0)); }
  .stripes { background-image:repeating-linear-gradient(45deg,#111 0 2px,transparent 2px 10px); }
  .cover { background:url(${assetOrigin}/photo.png) center/cover; }
  .gray img { filter:grayscale(1) brightness(.6); }
  .contain { background:#FAFAF9; }
  .contain img { object-fit:contain; }
  p { grid-column:1/-1; margin:0; }
  a { color:#2563EB; text-decoration:underline; }
  label { display:flex; gap:8px; align-items:center; }
  input { flex:1; height:36px; padding:0 12px; border:1px solid #D6D3D1; border-radius:8px; font:14px/20px Inter, sans-serif; box-sizing:border-box; min-width:0; }
  button { height:36px; padding:0 16px; border:0; border-radius:8px; background:#1C1917; color:#fff; font:600 14px/20px Inter, sans-serif; }
  .badge { position:absolute; inset:auto 8px 8px auto; padding:2px 8px; border-radius:999px; background:rgba(0,0,0,.6); color:#fff; font-size:12px; line-height:16px; }
</style></head><body>${body}</body></html>`;

// The source and the editor must use one font, or text metrics compare two different typefaces.
const server = Bun.serve({
  port:0,
  fetch(request) {
    const {pathname} = new URL(request.url);
    if (pathname.startsWith("/fonts/")) {
      return new Response(Bun.file(new URL(`../node_modules/@open-pencil/core/assets/${pathname.slice(7)}`, import.meta.url).pathname));
    }
    return new Response(page(`
      <section id="target">
        <h2>Payout overview</h2>
        <div class="tile gradient"><span class="badge">135deg</span></div>
        <div class="tile layered"></div>
        <div class="tile stripes"></div>
        <div class="tile"><img src="${assetOrigin}/photo.png" alt="Photo"></div>
        <div class="tile contain"><img src="${assetOrigin}/logo.svg" alt="Logo"></div>
        <div class="tile gray"><img src="${assetOrigin}/photo.png" alt="Filtered"></div>
        <div class="tile cover"></div>
        <div class="tile"><canvas id="chart" width="208" height="96"></canvas></div>
        <div class="tile" style="background:#FAFAF9">
          <svg width="100%" height="100%" viewBox="0 0 200 96" preserveAspectRatio="none">
            <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22C55E" stop-opacity=".8"/><stop offset="1" stop-color="#22C55E" stop-opacity="0"/></linearGradient></defs>
            <path d="M0 80 C40 20 80 70 120 40 S180 20 200 30 V96 H0 Z" fill="url(#area)"/>
            <path d="M0 80 C40 20 80 70 120 40 S180 20 200 30" fill="none" stroke="#15803D" stroke-width="2"/>
            <circle cx="120" cy="40" r="5" fill="#fff" stroke="#15803D" stroke-width="2"/>
          </svg>
        </div>
        <p>Set the minimum balance required before a payout is triggered. <a href="https://example.test/docs">Read the docs</a> for the schedule and limits that apply to your account.</p>
        <label style="grid-column:1/span 2"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#57534E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input placeholder="Search payouts"></label>
        <button>Save changes</button>
      </section>
      <script>
        const context = document.getElementById("chart").getContext("2d");
        context.fillStyle = "#1E293B"; context.fillRect(0, 0, 208, 96);
        context.fillStyle = "#38BDF8"; for (let x = 0; x < 13; x += 1) context.fillRect(4 + x * 16, 88 - (x * 37 % 70), 10, x * 37 % 70 + 8);
      </script>`), {headers:{"content-type":"text/html"}});
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const userDataDir = await mkdtemp(join(tmpdir(), "openpencil-capture-chrome-"));
let context;

const flatten = (graph, id) => graph.getChildren(id).flatMap((node) => [node, ...flatten(graph, node.id)]);

try {
  await mkdir(artifacts, {recursive:true});
  context = await chromium.launchPersistentContext(userDataDir, {
    channel:"chromium",
    headless:true,
    viewport:{width:800, height:900},
    deviceScaleFactor:1,
    args:[`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {origin});
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {timeout:15_000});
  const tab = context.pages()[0] || await context.newPage();
  await tab.goto(origin, {waitUntil:"networkidle"});
  await tab.evaluate(async () => {
    await Promise.all(["400 14px Inter", "600 14px Inter", "700 24px Inter"].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  });
  const target = tab.locator("#target");
  await target.screenshot({path:`${artifacts}source.png`, animations:"disabled"});

  await serviceWorker.evaluate(async () => {
    const [activeTab] = await chrome.tabs.query({active:true, currentWindow:true});
    const injection = {tabId:activeTab.id, allFrames:true};
    await chrome.scripting.executeScript({target:injection, files:["content.js"]});
  });
  await tab.locator("#__openpencil_capture_host__").waitFor({state:"attached"});
  const box = await target.boundingBox();
  await tab.mouse.move(box.x + 6, box.y + 6);
  await tab.mouse.click(box.x + 6, box.y + 6);
  try {
    await tab.waitForFunction(() => {
      const host = document.getElementById("__openpencil_capture_host__");
      return host && !host.shadowRoot.querySelector(".success-view").hidden;
    }, null, {timeout:60_000});
  } catch {
    const message = await tab.locator("#__openpencil_capture_host__").evaluate((host) => host.shadowRoot.querySelector(".capturing-message").textContent);
    throw new Error(`Capture did not complete: ${message}`);
  }

  // What the editor sees: a real paste event in a browser, and the plain-text route on the desktop.
  await tab.evaluate(() => {
    globalThis.__pasted = new Promise((resolve) => {
      addEventListener("paste", (event) => resolve({
        html:event.clipboardData.getData("text/html"),
        plain:event.clipboardData.getData("text/plain"),
      }), {once:true});
    });
  });
  await tab.keyboard.press("ControlOrMeta+V");
  const {html, plain} = await tab.evaluate(() => globalThis.__pasted);
  const envelope = html.match(/<!--\(openpencil\).*\(\/openpencil\)-->/s)?.[0];
  if (!envelope) throw new Error(`The paste event's HTML lost the envelope: ${html.slice(0, 200)}`);
  if (plain !== envelope) throw new Error("The plain-text flavor must carry the same envelope as the HTML flavor");

  await writeFile(`${artifacts}envelope.txt`, plain);
  const parsed = parseOpenPencilClipboard(plain);
  if (!parsed || parsed.images.size === 0) throw new Error(`The envelope carries no images: ${JSON.stringify({parsed:Boolean(parsed)})}`);

  const editor = createEditor();
  const pageId = editor.state.currentPageId;
  await editor.pasteFromHTML(plain);
  const [root] = editor.graph.getChildren(pageId);
  const nodes = flatten(editor.graph, pageId);
  const counts = nodes.reduce((total, node) => ({...total, [node.type]:(total[node.type] || 0) + 1}), {});
  const missing = nodes.filter((node) => node.name.includes("unavailable")).map((node) => node.name);
  if (missing.length) throw new Error(`Assets went missing: ${missing.join(", ")}`);
  const absentImages = nodes.flatMap((node) => node.fills).filter((fill) => fill.type === "IMAGE" && !editor.graph.images.has(fill.imageHash));
  if (absentImages.length) throw new Error(`${absentImages.length} image fills have no bytes`);
  for (const expected of ["GRADIENT_LINEAR", "IMAGE"]) {
    if (!nodes.some((node) => node.fills.some((fill) => fill.type === expected))) throw new Error(`No ${expected} fill survived`);
  }
  for (const type of ["TEXT", "VECTOR", "FRAME"]) if (!counts[type]) throw new Error(`No ${type} layer survived`);

  await writeFile(`${artifacts}openpencil-with-shadow.png`, await headlessRenderNodes(editor.graph, pageId, [root.id], {scale:1, format:"PNG"}));
  // An element screenshot stops at the element's box, so the comparison leaves the outer shadow out.
  editor.graph.updateNode(root.id, {effects:[]});
  const rendered = await headlessRenderNodes(editor.graph, pageId, [root.id], {scale:1, format:"PNG"});
  await writeFile(`${artifacts}openpencil.png`, rendered);
  await writeFile(`${artifacts}tree.json`, JSON.stringify(nodes.map(({id, type, name, x, y, width, height}) => ({id, type, name, x, y, width, height})), null, 1));

  const comparison = Bun.spawn(["bun", new URL("compare-visual.mjs", import.meta.url).pathname, `${artifacts}source.png`, `${artifacts}openpencil.png`, `${artifacts}comparison`, "--max-rmse", maxRmse], {stdout:"pipe", stderr:"pipe"});
  const [stdout, stderr, exitCode] = await Promise.all([new Response(comparison.stdout).text(), new Response(comparison.stderr).text(), comparison.exited]);
  console.log(JSON.stringify({bytes:html.length, images:parsed.images.size, counts, root:{name:root.name, width:root.width, height:root.height}, comparison:stdout.trim()}));
  if (exitCode !== 0) throw new Error(`Visual comparison failed: ${stdout}${stderr}`);

  if (editorUrl) {
    const editorTab = await context.newPage();
    await editorTab.setViewportSize({width:1280, height:860});
    await editorTab.goto(editorUrl, {waitUntil:"load", timeout:60_000});
    await editorTab.locator('[data-test-id="home-new-document"]').first().waitFor({state:"attached", timeout:30_000});
    await editorTab.evaluate(() => document.querySelector('[data-test-id="home-new-document"]').click());
    await editorTab.waitForFunction(() => {
      try { return Boolean(window.openPencil.getStore().state.currentPageId); } catch { return false; }
    }, null, {timeout:30_000});
    await editorTab.waitForTimeout(1500);
    await editorTab.keyboard.press("Escape");
    await editorTab.keyboard.press("ControlOrMeta+V");
    await editorTab.waitForFunction(() => {
      const store = window.openPencil.getStore();
      return store.graph.getChildren(store.state.currentPageId).length > 0;
    }, null, {timeout:15_000});
    await editorTab.waitForTimeout(3000);
    const editorResult = await editorTab.evaluate(() => {
      const store = window.openPencil.getStore();
      const walk = (id) => store.graph.getChildren(id).flatMap((node) => [node, ...walk(node.id)]);
      const pageNodes = walk(store.state.currentPageId);
      const imageFills = pageNodes.flatMap((node) => node.fills).filter((fill) => fill.type === "IMAGE");
      const faces = new Set(pageNodes.filter((node) => node.type === "TEXT").map((node) => `${node.fontFamily} ${node.fontWeight}${node.italic ? " italic" : ""}`));
      return {
        roots:store.graph.getChildren(store.state.currentPageId).map((node) => node.name),
        layers:pageNodes.length,
        imageFills:imageFills.length,
        imagesWithBytes:imageFills.filter((fill) => store.graph.images.has(fill.imageHash)).length,
        faces:[...faces],
        fontBanner:document.body.innerText.match(/\d+ font faces? [^\n]*/)?.[0] ?? null,
      };
    });
    await editorTab.screenshot({path:`${artifacts}editor-browser.png`});
    console.log(JSON.stringify({browserEditor:editorResult}));
    if (editorResult.layers !== nodes.length || editorResult.imagesWithBytes !== editorResult.imageFills) {
      throw new Error(`The hosted editor pasted something else: ${JSON.stringify({expected:nodes.length, editorResult})}`);
    }
  }
} finally {
  await context?.close();
  server.stop(true);
  assets.stop(true);
  await rm(userDataDir, {recursive:true, force:true});
}
