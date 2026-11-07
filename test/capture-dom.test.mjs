import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { convertCaptureToTree, cssColorToHex } from "../src/convert-capture.mjs";
import { hexToColor } from "../src/scene-nodes.mjs";
import { decodePng, renderInEditor } from "./support/render.mjs";
import { useBrowser } from "./support/browser.mjs";
import { captureBundle } from "../src/capture-url.mjs";

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
    // The closed <details> still draws its summary's triangle.
    expect(capture.nodes.filter((node) => node.tag === "::marker").map((node) => node.attributes.markerSymbol)).toEqual(["disclosure-closed"]);
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
  test("captures a frame the page cannot read in the frame's own document", async () => {
    const capture = await captureHtml(`<div id="root"><iframe src="data:text/html,<p>elsewhere</p>" style="width:100px;height:50px"></iframe></div>`);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "iframe", "html", "body", "p"]);
    expect(capture.nodes.at(-1)).toMatchObject({path:"0.0.0.1.0", parentPath:"0.0.0.1", text:"elsewhere"});
  });

  test("leaves the frame empty when nothing can reach it, and lists it", async () => {
    const script = await captureBundle();
    const capture = await captureHtml.evaluate(async (bundle) => {
      document.body.innerHTML = `<div id="root"><iframe src="data:text/html,<p>elsewhere</p>" style="width:100px;height:50px;border:2px solid"></iframe></div>`;
      await new Promise((resolve) => document.querySelector("iframe").addEventListener("load", resolve));
      new Function(bundle)();
      return globalThis.OpenPencilCapture.captureElement(document.querySelector("#root"), {captureFrame:() => { throw new Error("unreachable"); }});
    }, script);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "iframe"]);
    expect(capture.frames).toEqual([{path:"0.0", offset:{x:2, y:2}, clip:{left:0, top:0, right:100, bottom:50}}]);
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
      return {inverted:await pixelOf("invert(1)"), grayed:await pixelOf("grayscale(1) brightness(0.5)"), refused:await pixelOf("blur(1px)")};
    }, {source, red});
    expect(pixel.inverted).toEqual([0, 255, 255, 255]);
    expect(pixel.grayed).toEqual([27, 27, 27, 255]);
    // Mutation captured: without the allow-list the canvas would blur the pixel into its edges.
    expect(pixel.refused).toEqual([255, 0, 0, 255]);
  });
});

describe("pseudo-elements", () => {
  test("captures a positioned pseudo-element with its quoted text", async () => {
    const capture = await captureHtml(`<style>#root{position:relative;width:120px;height:40px}#root::after{content:"New";position:absolute;top:4px;right:4px;padding:2px 6px;background:rgb(220, 0, 0);color:white;font:12px Arial}#root::before{content:"•"}</style><div id="root"></div>`);
    expect(capture.nodes.map((node) => node.tag)).toEqual(["div", "::before", "::after"]);
    const {root} = convertCaptureToTree(capture);
    const after = root.children.find((child) => child.name === "After · Decoration");
    expect(after).toMatchObject({fill:"#DC0000", y:4});
    expect(after.children[0]).toMatchObject({type:"text", content:"New"});
  });
});

// A ::before lays out as a first child would and an ::after as a last one, so a real <span> in
// that place, with the same rules, shows where Chromium draws the pseudo-element.
describe("pseudo-elements in the flow", () => {
  const cases = {
    "inline text around a paragraph's text": [`.x{font:16px Arial;width:300px}`, `.x P1{content:"→ ";color:rgb(200, 0, 0)} .x P2{content:" »"}`, "Hello world"],
    "an inline-block icon in the middle of the line": [`.x{font:15px Arial;line-height:24px}`, `.x P1{content:"";display:inline-block;width:12px;height:12px;background:rgb(200, 0, 0);vertical-align:middle;margin-right:6px}`, "Label"],
    "an empty inline-block on the baseline": [`.x{font:18px Arial}`, `.x P2{content:"";display:inline-block;width:10px;height:10px;background:rgb(0, 0, 200);margin-left:4px}`, "Text"],
    "an inline badge in a smaller font with padding": [`.x{font:16px Arial}`, `.x P2{content:"NEW";font:bold 10px Arial;padding:2px 4px;background:rgb(0, 120, 60);color:white;margin-left:6px}`, "Release"],
    "a block divider under paragraphs": [`.x{font:14px Arial;width:200px} .x p{margin:6px 0}`, `.x P2{content:"";display:block;height:2px;background:rgb(0, 0, 0);margin-top:8px}`, "<p>One</p><p>Two</p>"],
    "flex items packed with a gap and centered": [`.x{display:flex;align-items:center;gap:8px;height:40px;font:14px Arial;padding:0 10px}`, `.x P1{content:"";width:16px;height:16px;background:rgb(200, 0, 0)} .x P2{content:"";width:10px;height:10px;border-radius:50%;background:rgb(0, 0, 200)}`, "<span>A</span><b>B</b>"],
    "flex items in a column": [`.x{display:flex;flex-direction:column;align-items:flex-end;row-gap:4px;width:120px;font:14px Arial}`, `.x P1{content:"";width:30px;height:6px;background:rgb(200, 0, 0)} .x P2{content:"";width:50px;height:4px;background:rgb(0, 0, 200)}`, "<div>One</div><div>Two</div>"],
    "a block before content, pushed by its margin": [`.x{font:14px Arial;padding:10px}`, `.x P1{content:"Note";display:block;font:bold 12px Arial;margin:0 0 4px 6px;padding:2px}`, "Body text"],
  };
  for (const [name, [base, rules, inner]] of Object.entries(cases)) {
    test(name, async () => {
      const pseudo = `<style>${base} ${rules.replaceAll("P1", "::before").replaceAll("P2", "::after").replaceAll(" ::", "::")}</style><div id="root" class="x">${inner}</div>`;
      const real = `<style>${base} ${rules.replaceAll("P1", "> .p1").replaceAll("P2", "> .p2").replace(/content:"((?:[^"\\]|\\.)*)";?/g, "")}</style><div id="root" class="x">${rules.includes("P1") ? `<span class="p1" id="p1">${rules.match(/P1\{content:"([^"]*)"/)[1]}</span>` : ""}${inner}${rules.includes("P2") ? `<span class="p2" id="p2">${rules.match(/P2\{content:"([^"]*)"/)[1]}</span>` : ""}</div>`;
      const captured = await captureHtml(pseudo);
      const reference = await captureHtml(real);
      for (const [tag, id] of [["::before", "p1"], ["::after", "p2"]]) {
        if (!rules.includes(id.toUpperCase())) continue;
        const node = captured.nodes.find((candidate) => candidate.tag === tag);
        const span = reference.nodes.find((candidate) => candidate.attributes.id === id);
        expect(node, tag).toBeDefined();
        for (const key of ["x", "y", "width", "height"]) expect(Math.abs(node.rect[key] - span.rect[key]), `${tag} ${key}: ${node.rect[key]} against ${span.rect[key]}`).toBeLessThan(1);
        if (span.textRect) for (const key of ["x", "y"]) expect(Math.abs(node.textRect[key] - span.textRect[key]), `${tag} text ${key}`).toBeLessThan(1);
      }
    });
  }
});

// Nothing can stand in for a marker, so the check is a picture: the list with its markers, against
// the list without them and each marker's text drawn by Chromium where the capture says it is.
describe("list markers", () => {
  // The marker's own ink: what is dark in `image` and not in `bare`, the list with markers hidden.
  const ink = ({width, data}, bare, box) => {
    let found = null;
    for (let y = Math.max(0, Math.floor(box.y)); y < Math.ceil(box.y + box.height); y += 1) {
      for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(width, Math.ceil(box.x + box.width)); x += 1) {
        if (data[(y * width + x) * 4] > 128 || bare.data[(y * width + x) * 4] <= 128) continue;
        found = found ? {left:Math.min(found.left, x), top:Math.min(found.top, y), right:Math.max(found.right, x), bottom:Math.max(found.bottom, y)} : {left:x, top:y, right:x, bottom:y};
      }
    }
    return found;
  };
  const cases = {
    "discs outside the text": `<ul id="root" style="font:16px Arial;margin:0;padding:4px 0 4px 40px;width:200px;background:white"><li>First</li><li style="font-size:22px">Second</li></ul>`,
    "circles in a nested list": `<ul id="root" style="font:18px Arial;margin:0;padding:4px 0 4px 30px;width:200px;list-style-type:circle;background:white"><li>Outer</li><li>Again</li></ul>`,
    "the disclosure triangles of details": `<div id="root" style="font:16px Arial;width:200px;padding:4px;background:white"><details><summary>Closed</summary>x</details><details open><summary>Open</summary>y</details></div>`,
    "squares inside the text": `<ul id="root" style="font:14px Verdana;margin:0;padding:4px 10px;width:200px;list-style:square inside;background:white"><li>First</li><li>Second</li></ul>`,
    "numbers from a start, inside the text": `<ol id="root" start="8" style="font:15px Georgia;margin:0;padding:4px 10px;width:200px;list-style-position:inside;background:white"><li>Eight</li><li>Nine</li><li>Ten</li></ol>`,
    "roman numerals and a marker of its own": `<style>#root li::marker{font:bold 13px Arial}</style><ol id="root" style="font:15px Arial;margin:0;padding:4px 0 4px 50px;width:200px;list-style-type:upper-roman;background:white"><li>One</li><li value="4">Four</li></ol>`,
  };
  for (const [name, html] of Object.entries(cases)) {
    test(name, async () => {
      const {capture, png} = await captureHtml(html, "#root", {screenshot:true});
      const markers = capture.nodes.filter((node) => node.tag === "::marker");
      expect(markers.length).toBeGreaterThan(1);
      const hidden = `<style>#root li::marker, #root summary::marker{color:transparent}</style>${html.replace(/(<(?:[uo]l|div) id="root" [^>]*style=")/, "$1position:relative;")}`;
      // A symbol is a shape the capture sizes; a text marker, its text in the marker's font.
      const triangles = {"disclosure-closed":"0,0 0.86,0.5 0,1", "disclosure-open":"0,0.07 0.5,0.93 1,0.07"};
      const spans = markers.map((marker) => triangles[marker.attributes.markerSymbol]
        ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none" style="position:absolute;left:${marker.rect.x}px;top:${marker.rect.y}px;width:${marker.rect.width}px;height:${marker.rect.height}px"><polygon points="${triangles[marker.attributes.markerSymbol]}"/></svg>`
        : marker.attributes.markerSymbol
        ? `<span style="position:absolute;left:${marker.rect.x}px;top:${marker.rect.y}px;width:${marker.rect.width}px;height:${marker.rect.height}px;background:${marker.attributes.markerSymbol === "circle" ? "none;border:1px solid black;box-sizing:border-box" : "black"};${marker.attributes.markerSymbol === "square" ? "" : "border-radius:50%;"}"></span>`
        : `<span style="position:absolute;left:${marker.textRect.x}px;top:${marker.textRect.y}px;line-height:${marker.textRect.height}px;font:${marker.styles.fontStyle} ${marker.styles.fontWeight} ${marker.styles.fontSize} ${marker.styles.fontFamily};white-space:pre">${marker.text}</span>`).join("");
      const bare = await captureHtml(hidden, "#root", {screenshot:true});
      const drawn = await captureHtml(hidden.replace(/(<\/[uo]l>|<\/div>$)/, `${spans}$1`), "#root", {screenshot:true});
      const [page, without, copy] = [await decodePng(png), await decodePng(bare.png), await decodePng(drawn.png)];
      for (const marker of markers) {
        const area = {x:marker.rect.x - 8, y:marker.rect.y - 4, width:marker.rect.width + 16, height:marker.rect.height + 8};
        const [expected, actual] = [ink(page, without, area), ink(copy, without, area)];
        expect(expected, marker.text).not.toBeNull();
        for (const key of ["left", "top", "right", "bottom"]) expect(Math.abs(actual[key] - expected[key]), `${marker.text} ${key}: ${actual[key]} against ${expected[key]}`).toBeLessThanOrEqual(1);
      }
      expect(markers.map((marker) => marker.text || marker.attributes.markerSymbol)).toEqual({discs:["disc", "disc"], circles:["circle", "circle"], the:["disclosure-closed", "disclosure-open"], squares:["square", "square"], numbers:["8.", "9.", "10."], roman:["I.", "IV."]}[name.split(" ")[0]]);
    });
  }
});

describe("a frame from another origin", () => {
  const frame = `<body style="margin:0;font:14px Arial"><p style="margin:4px">visible-frame-text</p><p style="position:absolute;top:300px">below-the-frame-secret</p><p style="position:absolute;left:4px;top:40px">clipped-by-the-page-secret</p></body>`;
  test("is captured in its own document, only where it shows", async () => {
    const capture = await captureHtml(`<div id="root" style="width:200px;height:50px;overflow:hidden;padding:0"><iframe src="https://frames.test/f.html" style="border:0;width:200px;height:120px;display:block"></iframe></div>`, "#root", {files:{"https://frames.test/f.html":frame}});
    expect(texts(convertCaptureToTree(capture))).toContain("visible-frame-text");
    // Below the frame's viewport, and inside it but under the page's clip: neither is drawn.
    expect(leaked(capture, ["below-the-frame-secret", "clipped-by-the-page-secret"])).toEqual([]);
    const text = capture.nodes.find((node) => node.text === "visible-frame-text");
    expect(text.parentPath.startsWith("0.0.0")).toBe(true);
    expect(capture.frames).toBeUndefined();
  });
});

describe("closed limitations, at the edges", () => {
  test("places a pseudo-element next to text straight inside a shadow root", async () => {
    const capture = await captureHtml(`<style>x-host::before{content:"* "}</style><div id="root"><x-host></x-host></div>`, "#root", {before:() => {
      customElements.define("x-host", class extends HTMLElement { constructor() { super(); this.attachShadow({mode:"open"}).textContent = "Hello shadow"; } });
    }});
    expect(capture.nodes.find((node) => node.tag === "::before")?.text).toBe("*");
  });

  test("reads nothing a clip-path inset cuts away", async () => {
    const capture = await captureHtml(`<div id="root" style="clip-path:inset(0 0 50% 0);height:80px;font:14px Arial"><p style="margin:0">top-visible</p><p style="margin:50px 0 0">bottom-secret</p></div>`);
    expect(leaked(capture, ["bottom-secret"])).toEqual([]);
    expect(leaked(capture, ["top-visible"])).toEqual(["top-visible"]);
  });

  test("leaves a transformed frame of another origin empty", async () => {
    const capture = await captureHtml(`<div id="root" style="width:200px;height:60px;overflow:hidden"><iframe src="https://frames.test/f.html" style="border:0;width:100px;height:60px;transform:scale(2);transform-origin:0 0"></iframe></div>`, "#root", {files:{"https://frames.test/f.html":`<body style="margin:0"><p style="margin:0">frame-text</p><p style="margin:45px 0 0">scaled-away-secret</p></body>`}});
    expect(leaked(capture, ["frame-text", "scaled-away-secret"])).toEqual([]);
  });
});

describe("a <use> that references another file", () => {
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></symbol></svg>`;
  test("reads a same-origin file the page draws from", async () => {
    const capture = await captureHtml(`<div id="root"><svg width="20" height="20"><use href="/s.svg#dot"/></svg></div>`, "#root", {files:{"/s.svg":sprite}});
    expect(capture.nodes.find((node) => node.tag === "circle")?.styles.fill).toBe("rgb(255, 0, 0)");
  });

  test("fetches no file for a hidden <use>, and uses none that is not SVG", async () => {
    const requests = [];
    const capture = await captureHtml(`<div id="root"><svg width="20" height="20" style="display:none"><use href="/hidden.svg#dot"/></svg><svg width="20" height="20"><use href="/s.txt#dot"/></svg></div>`, "#root", {files:{"/hidden.svg":sprite, "/s.txt":sprite}, requests});
    expect(requests.filter((url) => url.endsWith("hidden.svg"))).toEqual([]);
    expect(capture.nodes.some((node) => node.tag === "circle")).toBe(false);
  });

  // Chromium draws no cross-origin <use>, so the capture must not fetch one either.
  test("never asks another origin for a file", async () => {
    const requests = [];
    const capture = await captureHtml(`<div id="root"><svg width="20" height="20"><use href="https://elsewhere.test/s.svg#dot"/></svg></div>`, "#root", {files:{"/s.svg":sprite}, requests});
    expect(requests.filter((url) => url.includes("elsewhere.test"))).toEqual([]);
    expect(capture.nodes.some((node) => node.tag === "circle")).toBe(false);
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

  // Ground truth from Chromium's own pixels: an input's ::after is captured exactly where it is drawn.
  test("captures an input's pseudo-element only where Chromium draws it", async () => {
    const types = ["checkbox", "radio", "range", "color", "date", "file", "text", "password", "email", "number", "search", "button", "submit"];
    const cell = (type, appearance) => `<div style="position:relative;width:80px;height:50px"><input type="${type}" class="${appearance}" value="v"></div>`;
    const html = `<style>input{position:relative;width:70px;height:40px;margin:0}input::after{content:"PS";position:absolute;left:0;top:0;width:60px;height:40px;background:rgb(0, 255, 0)}
      .none{appearance:none}</style><div id="root">${types.flatMap((type) => [cell(type, "auto"), cell(type, "none")]).join("")}</div>`;
    const {capture, png} = await captureHtml(html, "#root", {screenshot:true, viewport:{width:200, height:1400}});
    const {width, data} = await decodePng(png);
    const drawn = capture.nodes.filter((node) => node.tag === "input").map((node, index) => {
      const x = Math.round(node.rect.x + 30);
      const y = Math.round(node.rect.y + 20);
      const [r, g, b] = data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3);
      return {input:`${types[Math.floor(index / 2)]}/${index % 2 ? "none" : "auto"}`, drawn:g > 200 && r < 60 && b < 60};
    });
    const captured = new Set(capture.nodes.filter((node) => node.tag === "::after").map((node) => node.parentPath));
    const inputs = capture.nodes.filter((node) => node.tag === "input");
    const mismatches = drawn.filter(({drawn: isDrawn}, index) => isDrawn !== captured.has(inputs[index].path));
    expect(mismatches).toEqual([]);
    expect(drawn.filter((entry) => entry.drawn).length).toBeGreaterThan(4);
    expect(drawn.find((entry) => entry.input === "password/none").drawn).toBe(false);
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

describe("pseudo-elements in the flat tree", () => {
  // Regression: a slotted element's ::after was placed from the light DOM, not the shadow tree.
  test("places a slotted element's pseudo-element in its shadow tree's containing block", async () => {
    const capture = await captureHtml(`<style>.chip::after{content:"";position:absolute;left:0;top:0;width:10px;height:10px;background:red}</style><div id="root"><x-frame><span class="chip">c</span></x-frame></div>`, "#root", {before:() => {
      customElements.define("x-frame", class extends HTMLElement {
        constructor() { super(); this.attachShadow({mode:"open"}).innerHTML = '<div style="position:relative;left:40px;top:30px"><slot></slot></div>'; }
      });
    }});
    const after = capture.nodes.find((node) => node.tag === "::after");
    expect([after.rect.x, after.rect.y]).toEqual([40, 30]);
  });
});
