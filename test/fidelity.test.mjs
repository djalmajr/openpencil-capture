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
async function fidelity(html, before, {crop = false, files = null} = {}) {
  const {capture, png} = await captureHtml(html, "#root", {screenshot:true, before, files});
  const rendered = await renderInEditor(capture);
  const page = await decodePng(png);
  const editor = await decodePng(await rendered.render());
  return {difference:meanDifference(page, crop ? cropImage(editor, page.width, page.height, crop) : editor), tree:rendered.tree};
}

// The editor exports a masked group with the bounds of what it masks, so content a mask cuts
// away can widen the image past the element, which is then its top-left corner. A border line's
// export bounds take half its width past each end, butt caps included, which centers the element.
function cropImage(image, width, height, at) {
  if (image.width < width || image.height < height) return image;
  const left = at === "center" ? (image.width - width) / 2 : 0;
  const top = at === "center" ? (image.height - height) / 2 : 0;
  if (!Number.isInteger(left) || !Number.isInteger(top)) return image;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) data.set(image.data.subarray(((y + top) * image.width + left) * 4, ((y + top) * image.width + left + width) * 4), y * width * 4);
  return {width, height, data};
}

const THRESHOLD = 0.015;

// A frame served from another origin, which the page cannot read.
const FRAME_FILES = {"https://frames.test/f.html":`<body style="margin:0;background:rgb(220, 240, 255)"><div style="margin:10px;width:60px;height:30px;background:rgb(200, 40, 40);border-radius:6px"></div><div style="position:absolute;left:90px;top:40px;width:80px;height:80px;background:linear-gradient(rgb(0, 160, 90), rgb(0, 60, 160))"></div></body>`};

// A sprite sheet in its own file, with a style rule, presentation attributes, inline style and
// currentColor, as icon sets ship them.
const SPRITE_FILES = {"/icons.svg":`<svg xmlns="http://www.w3.org/2000/svg"><style>.accent{fill:rgb(240, 160, 0)}</style>`
  + `<symbol id="badge" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="12" fill="currentColor"/><circle class="accent" cx="12" cy="18" r="4"/><path d="M4 22 H20" stroke="rgb(200, 0, 60)" style="stroke-width:2"/></symbol>`
  + `<g id="plain" transform="translate(4 4)"><rect width="10" height="10" fill="teal"/></g></svg>`};

describe("the pasted design looks like the page", () => {
  const cases = {
    "a linear gradient toward a side": box("background:linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))"),
    "a linear gradient toward a corner of a wide box": box("background:linear-gradient(to top right, rgb(255, 200, 0), rgb(0, 120, 255) 70%)"),
    "a linear gradient with stops in pixels": box("background:linear-gradient(30deg, rgb(20, 20, 20) 20px, rgb(240, 240, 240) 90px, rgb(200, 0, 120))"),
    "stops with positions left out": box("background:linear-gradient(90deg, red, yellow, lime 80%, aqua, blue)"),
    "a repeating linear gradient": box("background:repeating-linear-gradient(90deg, rgb(255, 255, 255) 0 10%, rgb(30, 30, 30) 10% 20%)"),
    "a gradient blended in oklab, as Tailwind writes it": box("background:linear-gradient(to right in oklab, rgb(255, 0, 0), rgb(0, 0, 255))"),
    "a gradient of oklch colors, which blends in oklab by default": box("background:linear-gradient(90deg, oklch(0.7 0.2 30), oklch(0.6 0.2 260))"),
    "a gradient around the long way of the hue wheel": box("background:linear-gradient(90deg in oklch longer hue, oklch(0.7 0.15 30), oklch(0.7 0.15 90))"),
    "a gradient bent by a color hint": box("background:linear-gradient(90deg, rgb(255, 255, 255), 15%, rgb(0, 0, 0))"),
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
    "content inside an open shadow root and its slot": box("background:rgb(255, 255, 255)", `<x-card style="display:block;width:160px;height:96px"><span style="display:block;width:40px;height:40px;background:rgb(30, 160, 90)"></span></x-card>`),
    "a same-origin frame": box("background:rgb(255, 255, 255)", `<iframe srcdoc="<body style='margin:0;background:rgb(250, 240, 200)'><div style='margin:10px;width:60px;height:30px;background:rgb(200, 40, 40)'></div></body>" style="display:block;width:140px;height:76px;margin:6px;border:4px solid rgb(40, 40, 40)"></iframe>`),
    "a frame from another origin": box("background:rgb(255, 255, 255)", `<iframe src="https://frames.test/f.html" style="display:block;width:140px;height:76px;margin:6px;border:4px solid rgb(40, 40, 40)"></iframe>`),
    "a sprite drawn through <use>": `<svg style="display:none"><symbol id="mark" viewBox="0 0 24 24"><path d="M2 2 H22 V12 H2 Z" fill="currentColor"/><circle cx="12" cy="18" r="4" fill="rgb(255, 160, 0)"/></symbol></svg>`
      + box("background:rgb(255, 255, 255);color:rgb(40, 90, 220)", `<svg width="96" height="96" style="display:block;margin-left:32px"><use href="#mark"/></svg>`),
    "a sprite drawn through <use> from another file": box("background:rgb(255, 255, 255);color:rgb(40, 90, 220)", `<svg width="96" height="96" style="display:block;margin-left:32px"><use href="/icons.svg#badge"/></svg><svg width="40" height="40" viewBox="0 0 20 20" style="position:absolute;left:4px;top:4px"><use href="icons.svg#plain"/></svg>`),
    "SVG shapes inside turned and moved groups": box("background:rgb(255, 255, 255)", `<svg width="160" height="96" viewBox="0 0 80 48" style="display:block"><g transform="translate(10 4)"><path d="M0 0 H20 V10 H0 Z" fill="rgb(0, 140, 200)"/></g><g transform="rotate(30 55 24)"><rect x="45" y="18" width="20" height="12" fill="rgb(220, 60, 60)"/></g></svg>`),
    "an SVG line from bottom left to top right": box("background:rgb(255, 255, 255)", `<svg width="160" height="96" style="display:block"><line x1="10" y1="86" x2="150" y2="10" stroke="rgb(20, 20, 20)" stroke-width="6"/></svg>`),
    "an SVG gradient defined outside the selection": `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="sky"><stop offset="0" stop-color="rgb(255, 120, 0)"/><stop offset="1" stop-color="rgb(80, 0, 200)"/></linearGradient></defs></svg>`
      + box("", `<svg width="160" height="96" style="display:block"><rect width="160" height="96" fill="url(#sky)"/></svg>`),
    "positioned pseudo-elements": `<style>#root{position:relative}#root::before{content:"";position:absolute;inset:12px 20px auto auto;width:40px;height:30px;padding:2px;border:2px solid rgb(0, 0, 200);background:rgb(240, 60, 60)}#root::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%, -50%);width:30px;height:30px;border-radius:50%;background:linear-gradient(rgb(0, 180, 90), rgb(0, 90, 180))}</style>`
      + box("background:rgb(255, 255, 255);border:3px solid rgb(30, 30, 30);box-sizing:border-box"),
    "a gradient anchored to the content box repeats over the padding": box("padding:20px;box-sizing:border-box;background:linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255)) content-box border-box"),
    "a userSpaceOnUse radial gradient on a moved shape": box("background:rgb(255, 255, 255)", `<svg width="160" height="96" viewBox="0 0 80 48" style="display:block"><defs><radialGradient id="spot" gradientUnits="userSpaceOnUse" cx="20" cy="20" r="16"><stop offset="0" stop-color="rgb(255, 220, 0)"/><stop offset="1" stop-color="rgb(200, 0, 80)"/></radialGradient></defs><g transform="translate(30 4)"><circle cx="20" cy="20" r="18" fill="url(#spot)"/></g></svg>`),
    "a color filter over a gradient, a border and a child": box("margin:8px;width:144px;height:80px;background:linear-gradient(90deg, rgb(200, 60, 30), rgb(30, 120, 200));border:6px solid rgb(40, 160, 60);box-sizing:border-box;filter:sepia(0.6) hue-rotate(40deg) saturate(1.4)", `<div style="margin:14px;width:40px;height:30px;background:rgb(250, 220, 40)"></div>`),
    "a grayscale and darkened dot grid": box("filter:grayscale(1) brightness(0.7);background:rgb(250, 200, 200) radial-gradient(circle, rgb(200, 30, 30) 4px, transparent 4px) 0 0 / 16px 16px"),
    "an inverted box with a filtered child": box("background:rgb(255, 255, 255);filter:invert(1)", `<div style="margin:16px;width:80px;height:40px;background:rgb(20, 120, 220);filter:contrast(1.6)"></div>`),
    "an ellipse drawn with border-radius 50% and a border": box("background:rgb(240, 180, 40);border:6px solid rgb(40, 40, 120);box-sizing:border-box;border-radius:50%"),
    "corners with two radii each, and borders of different widths": box("background:linear-gradient(rgb(0, 160, 200), rgb(0, 60, 120));border-style:solid;border-color:rgb(220, 60, 60);border-width:4px 10px 6px 2px;box-sizing:border-box;border-radius:60px 10px 30px 0 / 30px 40px 10px 0"),
    "a dashed border": box("background:rgb(255, 255, 255);border:4px dashed rgb(30, 30, 160);box-sizing:border-box"),
    "a thin dashed border": box("background:rgb(255, 255, 255);border:2px dashed rgb(30, 30, 30);box-sizing:border-box"),
    "a round dotted border": box("background:rgb(255, 255, 255);border:6px dotted rgb(200, 40, 40);box-sizing:border-box"),
    "dashed sides of different widths and styles": box("background:rgb(250, 250, 240);border-style:dashed solid dotted dashed;border-width:2px 5px 4px 6px;border-color:rgb(20, 120, 60);box-sizing:border-box"),
    "a rounded dashed border": box("background:rgb(255, 255, 255);border:4px dashed rgb(30, 30, 160);border-radius:16px;box-sizing:border-box"),
    "a rounded thin dashed border": box("background:rgb(255, 255, 255);border:2px dashed rgb(30, 30, 30);border-radius:12px;box-sizing:border-box"),
    "a rounded dotted border": box("background:rgb(255, 255, 255);border:4px dotted rgb(200, 40, 40);border-radius:30px;box-sizing:border-box"),
    "a polygon clip path": box("background:rgb(30, 130, 220);clip-path:polygon(50% 0, 100% 100%, 0 100%)"),
    "a circle clip path off center": box("background:linear-gradient(rgb(255, 120, 0), rgb(120, 0, 200));clip-path:circle(40px at 60% 50%)"),
    "an inset clip path with round corners": box("background:rgb(220, 40, 90);clip-path:inset(10px 20px round 12px)"),
    "an ellipse clip path": box("background:rgb(20, 160, 120);clip-path:ellipse(50% 30% at 40% 50%)"),
    "a path() clip path": box("background:rgb(80, 60, 200);clip-path:path('M0 0 L160 0 L80 90 Z')"),
    "a clip path over content that overflows": box("background:rgb(255, 255, 255);clip-path:inset(8px)", `<div style="width:220px;height:40px;background:rgb(200, 30, 30)"></div>`),
    "a clip path from an SVG clipPath in bounding-box units": `<svg width="0" height="0" style="position:absolute"><clipPath id="tri" clipPathUnits="objectBoundingBox"><path d="M0.5 0 L1 1 L0 1 Z"/><circle cx="0.15" cy="0.2" r="0.12"/></clipPath></svg>`
      + box("background:rgb(230, 120, 20);clip-path:url(#tri)"),
    "a clip path from an SVG clipPath in user space, turned": `<svg width="0" height="0" style="position:absolute"><clipPath id="bar"><rect x="20" y="30" width="120" height="30" transform="rotate(10 80 45)"/></clipPath></svg>`
      + box("background:rgb(40, 100, 200);clip-path:url(#bar)"),
    "a clipped group inside an SVG": box("background:rgb(255, 255, 255)", `<svg width="160" height="96" viewBox="0 0 80 48" style="display:block"><defs><clipPath id="half"><rect x="0" y="0" width="30" height="20"/></clipPath></defs><g transform="translate(10 6)" clip-path="url(#half)"><circle cx="20" cy="18" r="16" fill="rgb(200, 30, 120)"/></g><rect x="50" y="10" width="24" height="24" fill="rgb(30, 160, 90)" clip-path="url(#half)"/></svg>`),
    "a mask from an SVG mask element with a gradient": `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="fade"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient></defs><mask id="soft" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#fade)"/><circle cx="0.8" cy="0.5" r="0.15" fill="white"/></mask></svg>`
      + box("background:rgb(200, 30, 60);mask:url(#soft)"),
    "a masked shape inside an SVG": box("background:rgb(255, 255, 255)", `<svg width="160" height="96" viewBox="0 0 80 48" style="display:block"><mask id="hole"><rect width="80" height="48" fill="white"/><circle cx="40" cy="24" r="10" fill="black"/></mask><g transform="translate(4 2)"><rect x="10" y="4" width="60" height="38" fill="rgb(30, 120, 220)" mask="url(#hole)"/></g></svg>`),
    "a gradient mask": box("background:rgb(30, 90, 220);mask-image:linear-gradient(90deg, rgb(0, 0, 0), transparent)"),
    "a repeated radial mask": box("background:rgb(200, 40, 40);mask:radial-gradient(circle, rgb(0, 0, 0) 6px, transparent 6px) 0 0 / 20px 20px"),
    "an image at its natural size": box("background:rgb(255, 255, 255)", `<img src="${QUADRANTS}" style="width:160px;height:96px;object-fit:none;object-position:right 20px top 10px;display:block">`),
  };
  for (const [name, html] of Object.entries(cases)) {
    test(name, async () => {
      const {difference} = await fidelity(html.includes("<x-card") ? `<script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({mode:"open"}).innerHTML = '<div style="position:absolute;margin:20px 0 0 60px;width:80px;height:50px;background:rgb(240, 90, 30)"></div><div style="padding:8px"><slot></slot></div>'; } });</script>${html}` : html, name.startsWith("a scrolled") ? () => { document.querySelector("#root").scrollTop = 120; } : undefined, {crop:name.includes("overflows") ? "corner" : /dashed|dotted/.test(name) ? "center" : false, files:name.includes("another file") ? SPRITE_FILES : name.includes("another origin") ? FRAME_FILES : null});
      expect(difference).toBeLessThan(THRESHOLD);
    });
  }
});
