import { beforeAll, describe, expect, test } from "bun:test";
import { createEditor } from "@open-pencil/core/editor";
import { headlessRenderNodes, initCanvasKit, parseOpenPencilClipboard } from "@open-pencil/core";
import { convertCaptureToTree } from "../src/convert-capture.mjs";
import { createClipboardFromTree, createOpenPencilClipboardHtml } from "../src/openpencil-clipboard.mjs";
import { toSceneNodes } from "../src/scene-nodes.mjs";

const PNG_RED_PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));

const blank = {
  backgroundColor:"rgba(0, 0, 0, 0)", borderTopWidth:"0px", borderRightWidth:"0px", borderBottomWidth:"0px", borderLeftWidth:"0px",
  borderTopLeftRadius:"0px", borderTopRightRadius:"0px", borderBottomRightRadius:"0px", borderBottomLeftRadius:"0px", opacity:"1",
};

function captureFixture(nodes) {
  return {format:"openpencil-capture-ir", version:1, rootPath:"0", label:"Fixture", source:{url:"https://example.test/page"}, nodes};
}

const svgNamespace = "http://www.w3.org/2000/svg";
const fixture = captureFixture([
  {path:"0", parentPath:null, tag:"div", name:"root", text:null, rect:{x:0, y:0, width:200, height:120}, attributes:{}, styles:{...blank, backgroundColor:"rgb(255, 255, 255)"}},
  {path:"0.0", parentPath:"0", tag:"div", name:"panel", text:null, rect:{x:20, y:30, width:100, height:60}, attributes:{}, styles:{...blank, backgroundColor:"rgb(0, 128, 255)", borderTopWidth:"2px", borderRightWidth:"2px", borderBottomWidth:"2px", borderLeftWidth:"2px", borderTopStyle:"solid", borderRightStyle:"solid", borderBottomStyle:"solid", borderLeftStyle:"solid", borderTopColor:"rgb(0, 0, 0)", borderRightColor:"rgb(0, 0, 0)", borderBottomColor:"rgb(0, 0, 0)", borderLeftColor:"rgb(0, 0, 0)"}},
  {path:"0.0.0", parentPath:"0.0", tag:"span", name:"label", text:"Hi", textRect:{x:30, y:40, width:20, height:17}, textRuns:[{text:"Hi", rect:{x:30, y:40, width:20, height:17}}], rect:{x:30, y:40, width:20, height:17}, attributes:{}, styles:{...blank, color:"rgb(255, 255, 255)", fontFamily:"Inter", fontSize:"14px", fontWeight:"600", fontStyle:"normal", lineHeight:"20px", textAlign:"start", textTransform:"none"}},
  {path:"0.1", parentPath:"0", tag:"svg", namespace:svgNamespace, name:"svg", text:null, rect:{x:140, y:30, width:48, height:48}, attributes:{viewBox:"0 0 24 24"}, styles:{...blank, overflow:"hidden", fill:"none", stroke:"none"}},
  {path:"0.1.0", parentPath:"0.1", tag:"path", namespace:svgNamespace, name:"path", text:null, rect:{x:140, y:30, width:48, height:48}, attributes:{d:"M0 0 H24 V24 H0 Z"}, styles:{...blank, fill:"rgb(255, 0, 0)", stroke:"none", fillOpacity:"1", strokeWidth:"0"}},
]);

async function pngPixels(png) {
  const canvasKit = await initCanvasKit();
  const image = canvasKit.MakeImageFromEncoded(png);
  const width = image.width();
  const data = image.readPixels(0, 0, {width, height:image.height(), colorType:canvasKit.ColorType.RGBA_8888, alphaType:canvasKit.AlphaType.Unpremul, colorSpace:canvasKit.ColorSpace.SRGB});
  image.delete();
  return (x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
}

const flatten = (graph, id) => graph.getChildren(id).flatMap((node) => [node, ...flatten(graph, node.id)]);

async function pasteAndFind(html) {
  const editor = createEditor();
  const pageId = editor.state.currentPageId;
  await editor.pasteFromHTML(html);
  const nodes = flatten(editor.graph, pageId);
  return {editor, pageId, nodes, byName:(name) => nodes.find((node) => node.name.includes(name))};
}

describe("toolbar mark", () => {
  // Regression: ImageMagick rendered this PNG as a black square with two dots.
  test("shows the teal pencil on a transparent background, not a dark square", async () => {
    const png = new Uint8Array(await Bun.file(new URL("../extension/icons/openpencil-mark.png", import.meta.url)).arrayBuffer());
    const canvasKit = await initCanvasKit();
    const image = canvasKit.MakeImageFromEncoded(png);
    const size = image.width();
    const data = image.readPixels(0, 0, {width:size, height:image.height(), colorType:canvasKit.ColorType.RGBA_8888, alphaType:canvasKit.AlphaType.Unpremul, colorSpace:canvasKit.ColorSpace.SRGB});
    image.delete();
    expect(size).toBeGreaterThanOrEqual(40);
    let transparent = 0;
    let teal = 0;
    let dark = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
      if (alpha < 10) transparent += 1;
      else if (green > red + 40 && blue > red + 30) teal += 1;
      else if (red < 40 && green < 40 && blue < 40) dark += 1;
    }
    const total = data.length / 4;
    expect(transparent / total).toBeGreaterThan(0.3);
    expect(teal / total).toBeGreaterThan(0.2);
    expect(dark / total).toBeLessThan(0.01);
  }, 60_000);
});

describe("OpenPencil engine paste", () => {
  let pasted;
  beforeAll(async () => {
    const {html} = await createClipboardFromTree(convertCaptureToTree(fixture).root);
    pasted = await pasteAndFind(html);
  });

  test("the editor's own parser accepts the envelope", async () => {
    const {html} = await createClipboardFromTree(convertCaptureToTree(fixture).root);
    const parsed = parseOpenPencilClipboard(html);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toMatchObject({type:"FRAME", name:"Captured · Fixture"});
  });

  test("keeps hierarchy and parent-relative coordinates", () => {
    const panel = pasted.byName("Div · panel");
    expect(panel).toMatchObject({type:"FRAME", x:20, y:30, width:100, height:60, layoutMode:"NONE"});
    const label = pasted.byName("Span · label · Text");
    expect(label).toMatchObject({type:"TEXT", text:"Hi", fontWeight:600, fontSize:14, lineHeight:20});
    expect(pasted.editor.graph.getNode(label.parentId).name).toBe("Span · label");
  });

  test("the pasted root lands selected at the capture's own box", () => {
    const [root] = pasted.editor.graph.getChildren(pasted.pageId);
    expect(root).toMatchObject({width:200, height:120, x:0, y:0});
    expect([...pasted.editor.state.selectedIds]).toEqual([root.id]);
  });

  test("renders paint, border and vector in the right place", async () => {
    const [root] = pasted.editor.graph.getChildren(pasted.pageId);
    const png = await headlessRenderNodes(pasted.editor.graph, pasted.pageId, [root.id], {scale:1, format:"PNG"});
    expect(png.length).toBeGreaterThan(100);
    const pixel = await pngPixels(png);
    expect(pixel(5, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(21, 31)).toEqual([0, 0, 0, 255]);
    expect(pixel(100, 80)).toEqual([0, 128, 255, 255]);
    expect(pixel(160, 50)).toEqual([255, 0, 0, 255]);
  }, 60_000);

  test("embeds image bytes so the editor needs no network", async () => {
    const tree = {type:"frame", name:"Root", x:0, y:0, width:40, height:40, children:[
      {type:"rectangle", name:"Photo", x:0, y:0, width:40, height:40, fill:{type:"image", url:"https://example.test/a.png", mode:"fill"}},
    ]};
    const {html} = await createClipboardFromTree(tree, {loadImage:async () => PNG_RED_PIXEL});
    const {editor, byName} = await pasteAndFind(html);
    const fill = byName("Photo").fills[0];
    expect(fill).toMatchObject({type:"IMAGE", imageScaleMode:"FILL"});
    expect(fill.imageHash).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.from(editor.graph.images.get(fill.imageHash))).toEqual(Array.from(PNG_RED_PIXEL));
  });

  test("names a layer whose image could not be loaded instead of failing the capture", async () => {
    const tree = {type:"frame", name:"Root", x:0, y:0, width:40, height:40, children:[
      {type:"rectangle", name:"Photo", x:0, y:0, width:40, height:40, fill:{type:"image", url:"https://example.test/a.png", mode:"fill"}},
    ]};
    const {html, missingImages} = await createClipboardFromTree(tree, {loadImage:async () => null});
    expect(missingImages).toEqual(["https://example.test/a.png"]);
    const {byName} = await pasteAndFind(html);
    expect(byName("Photo · Image unavailable").fills).toEqual([]);
  });

  test("a group's box follows its children and they keep their place", async () => {
    const tree = {type:"frame", name:"Root", x:0, y:0, width:100, height:100, children:[
      {type:"group", name:"Wrapper", x:10, y:10, children:[
        {type:"rectangle", name:"Dot", x:5, y:7, width:20, height:30, fill:"#FF0000"},
      ]},
    ]};
    const {byName} = await pasteAndFind(createOpenPencilClipboardHtml([toSceneNodes(tree)]));
    expect(byName("Wrapper")).toMatchObject({type:"GROUP", x:15, y:17, width:20, height:30});
    expect(byName("Dot")).toMatchObject({x:0, y:0});
  });
});
