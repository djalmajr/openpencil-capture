import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { encodeBase64 } from "../src/base64.mjs";
import { encodePng } from "../src/css-background.mjs";
import { useBrowser } from "./support/browser.mjs";
import { decodePng, meanDifference, renderInEditor } from "./support/render.mjs";

const captureHtml = useBrowser();
setDefaultTimeout(60_000);

// An 8 × 8 image in four colored quadrants, so a misplaced or mis-scaled image shows.
const QUADRANTS = (() => {
  const colors = [[230, 40, 40], [40, 170, 60], [40, 80, 220], [240, 200, 30]];
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) rgba.set([...colors[(y >= 4 ? 2 : 0) + (x >= 4 ? 1 : 0)], 255], (y * 8 + x) * 4);
  }
  return `data:image/png;base64,${encodeBase64(encodePng(8, 8, rgba))}`;
})();

// Each fixture is one box with no text: text rasterizes differently in each engine.
const box = (style, inner = "") => `<div id="root" style="width:160px;height:96px;${style}">${inner}</div>`;

// The browser's pixels against the editor's, after capture and paste. A threshold of 1.5% of the
// channel range allows for antialiasing and image filtering, but not a gradient running the wrong
// way, a misplaced stop, or an image in the wrong place.
async function fidelity(html, before) {
  const {capture, png} = await captureHtml(html, "#root", {screenshot:true, before});
  const rendered = await renderInEditor(capture);
  return {difference:meanDifference(await decodePng(png), await decodePng(await rendered.render())), tree:rendered.tree};
}

const THRESHOLD = 0.015;

describe("the pasted design looks like the page", () => {
  const cases = {
    "a linear gradient toward a side": box("background:linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))"),
    "a linear gradient toward a corner of a wide box": box("background:linear-gradient(to top right, rgb(255, 200, 0), rgb(0, 120, 255) 70%)"),
    "a linear gradient with stops in pixels": box("background:linear-gradient(30deg, rgb(20, 20, 20) 20px, rgb(240, 240, 240) 90px, rgb(200, 0, 120))"),
    "stops with positions left out": box("background:linear-gradient(90deg, red, yellow, lime 80%, aqua, blue)"),
    "a repeating linear gradient": box("background:repeating-linear-gradient(90deg, rgb(255, 255, 255) 0 10%, rgb(30, 30, 30) 10% 20%)"),
    "a radial gradient to the farthest corner": box("background:radial-gradient(rgb(255, 255, 255), rgb(0, 90, 200))"),
    "an off-center circle to its closest side": box("background:radial-gradient(circle closest-side at 30% 40%, rgb(255, 230, 0), rgb(200, 30, 30) 80%, rgb(30, 30, 30))"),
    "an elliptical gradient with explicit radii": box("background:radial-gradient(60px 30px at 70% 60%, rgb(0, 200, 120), rgb(255, 255, 255))"),
    "a conic gradient": box("background:conic-gradient(from 45deg at 30% 40%, rgb(255, 0, 0), rgb(0, 0, 255) 50%, rgb(0, 160, 0))"),
    "a dot grid": box("background:rgb(250, 250, 250) radial-gradient(circle, rgb(30, 30, 30) 3px, transparent 3px) 0 0 / 16px 16px"),
    "a gradient over an image over a color": box(`background:linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.6)), url(${QUADRANTS}) center / cover, rgb(10, 10, 10)`),
    "an image placed in a corner without repeating": box(`background:rgb(255, 255, 255) url(${QUADRANTS}) right 10px bottom 8px / 40px no-repeat`),
    "an image repeated along one axis": box(`background:rgb(255, 255, 255) url(${QUADRANTS}) 0 20px / 24px repeat-x`),
    "a tiled image": box(`background:url(${QUADRANTS}) 5px 5px / 20px 20px`),
    "an image contained in its box": box("background:rgb(255, 255, 255)", `<img src="${QUADRANTS}" style="width:160px;height:96px;object-fit:contain;display:block;background:rgb(200, 220, 255)">`),
    "an image covering its box from a corner": box("", `<img src="${QUADRANTS}" style="width:160px;height:96px;object-fit:cover;object-position:0% 0%;display:block">`),
    "a scrolled container clips its content": `<div id="root" style="width:160px;height:96px;overflow:auto;scrollbar-width:none;background:rgb(255, 255, 255)"><div style="height:300px;margin:0 20px;background:linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))"></div></div>`,
    "a circle drawn with a percentage radius": `<div id="root" style="width:96px;height:96px;border-radius:50%;background:rgb(0, 120, 255)"></div>`,
    "a dashed SVG stroke": `<svg id="root" width="160" height="96" viewBox="0 0 80 48" style="display:block;background:rgb(255, 255, 255)"><path d="M4 24 H76" stroke="rgb(200, 30, 30)" stroke-width="4" stroke-dasharray="6 3"/></svg>`,
    "an image at its natural size": box("background:rgb(255, 255, 255)", `<img src="${QUADRANTS}" style="width:160px;height:96px;object-fit:none;object-position:right 20px top 10px;display:block">`),
  };
  for (const [name, html] of Object.entries(cases)) {
    test(name, async () => {
      const {difference} = await fidelity(html, name.startsWith("a scrolled") ? () => { document.querySelector("#root").scrollTop = 120; } : undefined);
      expect(difference).toBeLessThan(THRESHOLD);
    });
  }
});
