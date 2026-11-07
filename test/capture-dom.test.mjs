import { describe, expect, setDefaultTimeout, test } from "bun:test";
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
