import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { convertCaptureToTree, cssColorToHex } from "../src/convert-capture.mjs";
import { hexToColor } from "../src/scene-nodes.mjs";
import { renderInEditor } from "./support/render.mjs";
import { useBrowser } from "./support/browser.mjs";

const captureHtml = useBrowser();
setDefaultTimeout(20_000);

const leaked = (capture, values) => values.filter((value) => JSON.stringify(capture).includes(value));

const texts = (tree) => {
  const found = [];
  const visit = (node) => { if (node.type === "text") found.push(node.content); node.children?.forEach(visit); };
  visit(tree.root);
  return found;
};

describe("what a capture may contain", () => {
  // Mutation captured: dropping the checkVisibility() skip records the collapsed text.
  test("leaves out content the page collapses or hides", async () => {
    const capture = await captureHtml(`<div id="root">
      <p>shown</p>
      <details><summary>Summary</summary><p>closed-secret</p></details>
      <div hidden="until-found">until-found-secret</div>
      <div style="content-visibility:hidden">content-visibility-secret</div>
      <div style="display:none">display-secret</div>
      <div style="opacity:0"><span>opacity-secret</span><input value="opacity-input-secret"></div>
      <span style="visibility:hidden">visibility-secret</span>
    </div>`);
    expect(leaked(capture, ["closed-secret", "until-found-secret", "content-visibility-secret", "display-secret", "opacity-secret", "opacity-input-secret", "visibility-secret"])).toEqual([]);
    expect(texts(convertCaptureToTree(capture))).toEqual(["shown", "Summary"]);
  });

  // Mutation captured: ignoring the clip chain keeps values that are moved or clipped out of sight.
  test("keeps the values of controls nobody can see out of the capture", async () => {
    const capture = await captureHtml(`<form id="root" style="position:relative;width:300px">
      <input value="visible-value">
      <input style="position:absolute;left:-9999px" value="offscreen-secret">
      <div style="height:0;overflow:hidden"><input value="collapsed-secret"></div>
      <div style="height:30px;overflow:auto"><div style="height:200px"></div><input value="scrolled-secret"></div>
      <div style="width:1px;height:1px;overflow:hidden;position:absolute"><input value="tiny-secret"></div>
    </form>`);
    expect(leaked(capture, ["offscreen-secret", "collapsed-secret", "scrolled-secret", "tiny-secret"])).toEqual([]);
    expect(leaked(capture, ["visible-value"])).toEqual(["visible-value"]);
  });

  test("refuses a selection the page does not render", async () => {
    await expect(captureHtml(`<details><summary>s</summary><p id="root">inside</p></details>`)).rejects.toThrow("not visible");
  });

  test("records the blend mode an overlay paints with", async () => {
    const capture = await captureHtml(`<div id="root"><div style="width:20px;height:20px;background:red;mix-blend-mode:multiply"></div></div>`);
    expect(capture.nodes[1].styles.mixBlendMode).toBe("multiply");
  });
});

describe("colors as the browser paints them", () => {
  // Mutation captured: a wrong matrix or transfer function moves a channel by more than 2/255.
  test("converts every computed color syntax to the sRGB the browser paints", async () => {
    const colors = [
      "lch(50% 40 120)", "lab(50 -20 30)", "oklch(0.6 0.1 200)", "oklch(none 0.05 20)", "oklab(0.7 -0.05 0.08 / 0.5)",
      "color(display-p3 0.8 0.3 0.2)", "color(srgb 0.5 0.25 0.75)", "color(srgb-linear 0.2 0.5 0.1)",
      "color(rec2020 0.5 0.3 0.2)", "color(a98-rgb 0.5 0.4 0.3)", "color(prophoto-rgb 0.5 0.4 0.3)",
      "color(xyz-d65 0.2 0.3 0.4)", "color(xyz-d50 0.3 0.3 0.2)", "color-mix(in srgb, red 30%, blue)", "hsl(120 50% 50%)",
    ];
    const painted = await captureHtml.evaluate((colors) => colors.map((color) => {
      const probe = document.createElement("div");
      probe.style.color = color;
      document.body.append(probe);
      const computed = getComputedStyle(probe).color;
      const context = Object.assign(document.createElement("canvas"), {width:1, height:1}).getContext("2d");
      context.fillStyle = computed;
      context.fillRect(0, 0, 1, 1);
      return {color, computed, pixel:Array.from(context.getImageData(0, 0, 1, 1).data)};
    }), colors);
    const misses = painted.flatMap(({color, computed, pixel}) => {
      const {r, g, b, a} = hexToColor(cssColorToHex(computed));
      const ours = [r, g, b].map((value) => Math.round(value * 255));
      const theirs = pixel.slice(0, 3);
      const off = Math.max(...ours.map((value, index) => Math.abs(value - theirs[index])), Math.abs(Math.round(a * 255) - pixel[3]));
      return off > 2 ? [{color, computed, ours, theirs}] : [];
    });
    expect(misses).toEqual([]);
  });
});

describe("backgrounds", () => {
  test("paints text clipped to its background with that background", async () => {
    const capture = await captureHtml(`<h1 id="root" style="margin:0;font:700 32px Arial;background:linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255));-webkit-background-clip:text;background-clip:text;color:transparent">Gradient</h1>`);
    const {root} = convertCaptureToTree(capture);
    expect(root.fill).toBeUndefined();
    expect(root.children[0].fill).toEqual([{type:"gradient", gradientType:"linear", rotation:270, colors:[{color:"#FF0000", position:0}, {color:"#0000FF", position:1}]}]);
  });

  // Regression: transparent text was painted black.
  test("leaves transparent text unpainted", async () => {
    const capture = await captureHtml(`<p id="root" style="margin:0;color:transparent">Hidden ink</p>`);
    expect(convertCaptureToTree(capture).root.children[0].fill).toBe("#00000000");
  });

  // Mutation captured: keeping a partial layer as a frame fill would paint it under the layers
  // below it, and over the whole box.
  test("keeps every layer above a partial one in its own rectangle, in order", async () => {
    const capture = await captureHtml(`<div id="root" style="width:100px;height:60px;background:linear-gradient(rgba(0, 0, 0, 0.5), transparent), radial-gradient(red, blue) 10px 10px / 20px 20px no-repeat, rgb(250, 250, 250)"></div>`);
    const {root} = convertCaptureToTree(capture);
    expect(root.fill).toBe("#FAFAFA");
    expect(root.children.map((child) => [child.name, child.x, child.y, child.width, child.height, child.fill.gradientType])).toEqual([
      ["Div · Background image 1", 10, 10, 20, 20, "radial"],
      ["Div · Background image 2", 0, 0, 100, 60, "linear"],
    ]);
  });
});

describe("text", () => {
  // Mutation captured: collapsing whitespace everywhere joins the columns of preformatted text.
  test("keeps the spaces preformatted text shows", async () => {
    const capture = await captureHtml(`<pre id="root" style="margin:0;font:14px monospace">a  b   c\n\tindented</pre>`);
    expect(capture.nodes[0].textRuns.map((run) => run.text)).toEqual(["a  b   c", "        indented"]);
  });

  test("collapses spaces everywhere else", async () => {
    const capture = await captureHtml(`<p id="root" style="margin:0">  a   b  </p>`);
    expect(capture.nodes[0].text).toBe("a b");
  });

  // Regression: text took the first family listed even when the page fell back to another one.
  test("names the family the browser drew with", async () => {
    const capture = await captureHtml(`<p id="root" style="margin:0;font-family:'No Such Font Anywhere', Arial, sans-serif">Fallback</p>`);
    expect(capture.nodes[0].fontFamily).toBe("Arial");
    expect(convertCaptureToTree(capture).root.children[0].fontFamily).toBe("Arial");
  });

  test("links text to its absolute target in the editor", async () => {
    const capture = await captureHtml(`<a id="root" href="/docs?page=2" style="display:inline-block">Docs</a>`);
    const {nodes} = await renderInEditor(capture);
    const text = nodes.find((node) => node.type === "TEXT");
    expect(text.styleRuns).toEqual([{start:0, length:4, style:{hyperlink:{type:"URL", value:"https://example.test/docs?page=2"}}}]);
  });

  test("links nowhere a design file cannot open", async () => {
    const capture = await captureHtml(`<a id="root" href="javascript:alert(1)" style="display:inline-block">Run</a>`);
    expect(convertCaptureToTree(capture).root.children[0].href).toBeUndefined();
  });
});

describe("documents inside the page", () => {
  test("leaves a cross-origin frame empty without failing the capture", async () => {
    const capture = await captureHtml(`<div id="root"><iframe src="data:text/html,<p>elsewhere</p>" style="width:100px;height:50px"></iframe></div>`);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "iframe"]);
  });

  test("reads an open shadow root and what its slot shows, not the light DOM it replaces", async () => {
    const capture = await captureHtml(`<div id="root"><x-tag>slotted</x-tag></div>`, "#root", {before:() => {
      customElements.define("x-tag", class extends HTMLElement {
        constructor() { super(); this.attachShadow({mode:"open"}).innerHTML = "<b>shadow</b> <slot></slot>"; }
      });
    }});
    expect(capture.nodes.filter((node) => node.text).map((node) => [node.tag, node.text])).toEqual([["b", "shadow"], ["slot", "slotted"]]);
  });
});

describe("baking filters into images", () => {
  test("the extension's rasterizer draws the image through its color filters", async () => {
    const source = (await readFile(new URL("../src/extension/rasterize.mjs", import.meta.url), "utf8")).replace(/\bexport\s+/g, "");
    const red = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const pixel = await captureHtml.evaluate(async ({source, red}) => {
      const rasterizeImage = new Function(`${source}; return rasterizeImage;`)();
      const pixelOf = async (filter) => {
        const image = new Image();
        image.src = await rasterizeImage(red, {width:2, height:2, filter});
        await image.decode();
        const context = Object.assign(document.createElement("canvas"), {width:1, height:1}).getContext("2d");
        context.drawImage(image, 0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      return {inverted:await pixelOf("invert(1)"), refused:await pixelOf("grayscale(1)")};
    }, {source, red});
    expect(pixel.inverted).toEqual([0, 255, 255, 255]);
    // Mutation captured: without the allow-list the canvas would gray the pixel.
    expect(pixel.refused).toEqual([255, 0, 0, 255]);
  });
});

describe("pseudo-elements", () => {
  test("captures a positioned pseudo-element with its quoted text, and leaves inline ones out", async () => {
    const capture = await captureHtml(`<style>#root{position:relative;width:120px;height:40px}#root::after{content:"New";position:absolute;top:4px;right:4px;padding:2px 6px;background:rgb(220, 0, 0);color:white;font:12px Arial}#root::before{content:"•"}</style><div id="root"></div>`);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "::after"]);
    const {root} = convertCaptureToTree(capture);
    expect(root.children[0]).toMatchObject({name:"After · Decoration", fill:"#DC0000", y:4});
    expect(root.children[0].children[0]).toMatchObject({type:"text", content:"New"});
  });
});

// Regressions found in review: each of these showed text the page does not draw.
describe("what a capture may contain, at the edges", () => {
  test("leaves out text written straight inside a closed <details>", async () => {
    const capture = await captureHtml(`<div id="root"><details><summary>S</summary>DIRECTSECRET</details></div>`);
    expect(leaked(capture, ["DIRECTSECRET"])).toEqual([]);
    expect(capture.label).toBe("S");
  });

  test("does not enter a frame the page hides", async () => {
    const frame = `<iframe srcdoc="<p>frame-secret</p><input value='frame-input-secret'>" style="width:200px;height:80px"></iframe>`;
    for (const html of [`<div id="root"><div style="visibility:hidden">${frame}</div></div>`, `<div id="root">${frame.replace('style="', 'style="visibility:hidden;')}</div>`]) {
      expect(leaked(await captureHtml(html), ["frame-secret", "frame-input-secret"])).toEqual([]);
    }
  });

  test("clips an element's own text by its own overflow, character by character", async () => {
    const capture = await captureHtml(`<div id="root">
      <div style="height:20px;line-height:20px;overflow:hidden">line one<br>SECONDLINEHIDDEN</div>
      <div style="height:0;overflow:hidden">ZEROHEIGHT</div>
      <div style="width:120px;overflow:hidden;white-space:nowrap;font:16px monospace">visible ZZZZZZZZZZZZZZZZ HIDDENTAIL</div>
    </div>`);
    expect(leaked(capture, ["SECONDLINEHIDDEN", "ZEROHEIGHT", "HIDDENTAIL"])).toEqual([]);
    expect(leaked(capture, ["line one", "visible"])).toEqual(["line one", "visible"]);
  });

  test("leaves out the pseudo-elements of content the page skips, and masks masked ones", async () => {
    const capture = await captureHtml(`<style>
      #cv{position:relative;content-visibility:hidden;width:100px;height:40px}
      #cv::after{content:"PSEUDOSECRET";position:absolute;top:0;left:0;width:80px;height:20px;background:red}
      #mask{position:relative;-webkit-text-security:disc;width:100px;height:40px}
      #mask::after{content:"MASKEDPSEUDO";position:absolute;top:0;left:0;width:80px;height:20px}
    </style><div id="root"><div id="cv"></div><div id="mask"></div></div>`);
    expect(leaked(capture, ["PSEUDOSECRET", "MASKEDPSEUDO"])).toEqual([]);
    expect(capture.nodes.find((node) => node.tag === "::after")?.text).toBe("••••••••••••");
  });

  // Chromium draws pseudo-elements on an `appearance:none` input, the usual custom checkbox.
  test("keeps the mark of a custom checkbox and draws none on a native one", async () => {
    const capture = await captureHtml(`<style>input{position:relative;width:20px;height:20px}input::after{content:"";position:absolute;inset:4px;background:rgb(0, 150, 80)}.custom{appearance:none}</style>
      <div id="root"><input class="custom" type="checkbox"><input type="checkbox"></div>`);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "input", "::after", "input"]);
  });

  // Regression: Astro islands nest display:contents wrappers, and their content was dropped.
  test("keeps content inside nested display:contents wrappers", async () => {
    const capture = await captureHtml(`<div id="root"><astro-island style="display:contents"><astro-slot style="display:contents"><p>island</p></astro-slot></astro-island></div>`);
    expect(capture.nodes.filter((node) => node.text).map((node) => node.text)).toEqual(["island"]);
  });

  test("finds a font declared inside a frame, and one limited to the characters it covers", async () => {
    const inter = (await readFile(new URL("../node_modules/@open-pencil/core/assets/Inter-Regular.ttf", import.meta.url))).toString("base64");
    const face = (family, range = "") => `@font-face{font-family:${family};src:url(data:font/ttf;base64,${inter})${range}}`;
    const capture = await captureHtml(`<style>${face("SubFont", ";unicode-range:U+0400-04FF")}</style>
      <div id="root"><p style="font-family:SubFont, serif">Привет</p><p style="font-family:SubFont, serif">Latin</p>
      <iframe srcdoc="<style>${face("FrameFont")}</style><p style='font-family:FrameFont, serif'>Framed</p>" style="width:200px;height:60px"></iframe></div>`, "#root", {before:async () => {
      const frame = document.querySelector("iframe");
      if (!frame.contentDocument?.body) await new Promise((resolve) => frame.addEventListener("load", resolve, {once:true}));
      await Promise.all([...document.fonts].map((font) => font.load()));
      await Promise.all([...frame.contentDocument.fonts].map((font) => font.load()));
    }});
    expect(capture.nodes.filter((node) => node.text).map((node) => [node.text, node.fontFamily])).toEqual([["Привет", "SubFont"], ["Latin", "serif"], ["Framed", "FrameFont"]]);
  });
});
