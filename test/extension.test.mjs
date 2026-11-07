import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { inflateSync } from "fflate";
import { isPageCaptureShortcut, pageCaptureModifier } from "../src/extension/shortcuts.mjs";
import { createOpenPencilClipboardHtml } from "../src/openpencil-clipboard.mjs";
import { fetchExtensionAsset } from "../src/extension/asset-fetch.mjs";
import { effectiveFilter } from "../src/capture-element.mjs";
import { captureProgressForElapsed } from "../src/extension/capture-progress.mjs";
import { frameRequest, framePath } from "../src/extension/frame-request.mjs";
import { isBakedFilter, rasterSize } from "../src/extension/rasterize.mjs";
import { waitForVisualStability } from "../src/extension/visual-stability.mjs";
import { writeClipboardPayload } from "../src/extension/write-clipboard.mjs";
import { decodeDataUrl, isEditorDecodableImage, loadImageBytes } from "../src/load-image.mjs";

const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function stubClipboardItem() {
  const original = globalThis.ClipboardItem;
  globalThis.ClipboardItem = class ClipboardItem {
    constructor(data) { this.data = data; this.types = Object.keys(data); }
  };
  return () => { globalThis.ClipboardItem = original; };
}

function copyEventDocument(copied, {succeeds = true} = {}) {
  let listener;
  return {
    addEventListener:(_type, nextListener) => { listener = nextListener; },
    removeEventListener:() => { listener = undefined; },
    execCommand:() => {
      if (!succeeds) return false;
      listener({clipboardData:{setData:(type, value) => { copied[type] = value; }}, preventDefault:() => {}});
      return true;
    },
  };
}

describe("extension clipboard contract", () => {
  test("encodes OpenPencil's native clipboard envelope", () => {
    const node = {type:"FRAME", name:"Captured card", width:320, height:200, children:[]};
    const html = createOpenPencilClipboardHtml([node], new Map([["abc", new Uint8Array([1, 2, 3])]]));
    const encoded = html.match(/^<!--\(openpencil\)(.*)\(\/openpencil\)-->$/s)?.[1];
    expect(encoded).toBeTruthy();
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(inflateSync(bytes)))).toEqual({
      format:"openpencil/v1",
      nodes:[node],
      images:{abc:"AQID"},
    });
  });

  // Mutation captured: wrapping the comment in any element leaves text/html non-empty after
  // WebKit sanitizes it, and the desktop app then never reaches its plain-text route.
  test("the HTML flavor holds nothing but the comment", () => {
    const html = createOpenPencilClipboardHtml([{type:"FRAME", name:"Card"}]);
    expect(html.startsWith("<!--(openpencil)")).toBe(true);
    expect(html.endsWith("(/openpencil)-->")).toBe(true);
    expect(html.slice(4, -3)).not.toContain("<");
  });

  test("rejects an empty capture", () => {
    expect(() => createOpenPencilClipboardHtml([])).toThrow(TypeError);
  });

  test("declares OpenPencil icons for the extension and action", async () => {
    const manifest = JSON.parse(await readSource("extension/manifest.json"));
    expect(manifest.name).toBe("OpenPencil Capture");
    expect(manifest.description).toContain("for OpenPencil");
    expect(manifest.action.default_icon["16"]).toBe("icons/icon-16.png");
    expect(manifest.icons["128"]).toBe("icons/icon-128.png");
    expect(manifest.web_accessible_resources[0].resources).toEqual(["icons/openpencil-mark.png"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  test("declares what the offscreen clipboard writer needs", async () => {
    const manifest = JSON.parse(await readSource("extension/manifest.json"));
    expect(manifest.permissions).toContain("offscreen");
    expect(manifest.permissions).toContain("clipboardWrite");
  });

  // Mutation captured: trying clipboard.write first would reserialize text/html with document
  // markup, so the flavor would no longer hold only the comment.
  test("writes the raw envelope through a copy event before the reserializing async API", async () => {
    const copied = {};
    let asyncWrites = 0;
    const result = await writeClipboardPayload({html:"<!--(openpencil)x(/openpencil)-->"}, {
      clipboard:{write:async () => { asyncWrites += 1; }},
      documentRef:copyEventDocument(copied),
    });
    expect(result).toEqual({ok:true, types:["text/html", "text/plain"]});
    expect(asyncWrites).toBe(0);
    expect(copied).toEqual({"text/html":"<!--(openpencil)x(/openpencil)-->", "text/plain":"<!--(openpencil)x(/openpencil)-->"});
  });

  test("falls back to the async API when the copy command is refused", async () => {
    const restore = stubClipboardItem();
    const writes = [];
    try {
      const result = await writeClipboardPayload({html:"<!--(openpencil)x(/openpencil)-->"}, {
        clipboard:{write:async (items) => writes.push(items)},
        documentRef:copyEventDocument({}, {succeeds:false}),
      });
      expect(result.ok).toBe(true);
      expect(writes[0][0].types).toEqual(["text/html", "text/plain"]);
    } finally {
      restore();
    }
  });

  test("reports bounded capture progress until real completion", () => {
    expect(captureProgressForElapsed(0)).toBe(4);
    expect(captureProgressForElapsed(450)).toBeGreaterThanOrEqual(20);
    expect(captureProgressForElapsed(450)).toBeLessThan(35);
    expect(captureProgressForElapsed(60_000)).toBe(95);
  });

  test("combines an image's own filter with inherited filters", () => {
    const root = {filter:"grayscale(1)",parentElement:null};
    const image = {filter:"brightness(0.6)",parentElement:root};
    expect(effectiveFilter(image,root,(node) => ({filter:node.filter}))).toBe("brightness(0.6) grayscale(1)");
  });

  test("waits until animated SVG geometry stops changing", async () => {
    const signatures = ["arc-10","arc-30","arc-80","arc-80","arc-80"];
    const result = await waitForVisualStability(() => signatures.shift() || "arc-80",{
      intervalMs:0,stableSamples:2,timeoutMs:100,sleep:async () => {},
    });
    expect(result).toEqual({stable:true,signature:"arc-80"});
  });
});

describe("image loading", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");

  test("recognizes the formats the editor can decode by their signature", () => {
    expect(isEditorDecodableImage(PNG)).toBe(true);
    expect(isEditorDecodableImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isEditorDecodableImage(new TextEncoder().encode("GIF89a"))).toBe(true);
    expect(isEditorDecodableImage(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe(true);
    expect(isEditorDecodableImage(new TextEncoder().encode("RIFF0000WAVEfmt "))).toBe(false);
    expect(isEditorDecodableImage(SVG)).toBe(false);
  });

  test("decodes base64 and percent-encoded data URLs", () => {
    expect(Array.from(decodeDataUrl("data:image/png;base64,AQID"))).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(decodeDataUrl("data:image/svg+xml,%3Csvg%2F%3E"))).toBe("<svg/>");
  });

  test("returns fetched bytes the editor can decode untouched", async () => {
    const fetchImpl = async () => new Response(PNG);
    expect(Array.from(await loadImageBytes("https://example.test/a.png", {width:1, height:1}, {fetchImpl}))).toEqual(Array.from(PNG));
  });

  test("gives up on a format it cannot rasterize outside the extension", async () => {
    const fetchImpl = async () => new Response(SVG);
    expect(await loadImageBytes("https://example.test/a.svg", {width:1, height:1}, {fetchImpl})).toBeNull();
  });

  test("gives up on an image the page cannot fetch outside the extension", async () => {
    const fetchImpl = async () => new Response("nope", {status:404});
    expect(await loadImageBytes("https://example.test/a.png", {width:1, height:1}, {fetchImpl})).toBeNull();
  });

  test("the extension fetch returns a typed data URL", async () => {
    const result = await fetchExtensionAsset("https://example.test/a.png", {fetchImpl:async () => new Response(new Blob([PNG], {type:"image/png"}))});
    expect(result).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  // Mutation captured: dropping credentials:"omit" lets a captured page's markup pull the user's
  // authenticated resources from other sites into the clipboard.
  test("the extension fetch sends no cookies", async () => {
    const calls = [];
    await fetchExtensionAsset("https://example.test/a.png", {fetchImpl:async (_url, init) => {
      calls.push(init);
      return new Response(new Blob([PNG], {type:"image/png"}));
    }});
    expect(calls[0].credentials).toBe("omit");
  });

  test("the extension fetch refuses anything but http(s) images", async () => {
    const fetchImpl = async () => new Response(new Blob(["{\"secret\":1}"], {type:"application/json"}));
    expect(fetchExtensionAsset("file:///etc/hosts", {fetchImpl})).rejects.toThrow("Unsupported asset protocol");
    expect(fetchExtensionAsset("https://example.test/data.json", {fetchImpl})).rejects.toThrow("not an image");
  });

  test("the extension fetch accepts an image served with a generic type", async () => {
    const fetchImpl = async () => new Response(new Blob([PNG], {type:"application/octet-stream"}));
    expect(await fetchExtensionAsset("https://example.test/a", {fetchImpl})).toStartWith("data:application/octet-stream;base64,");
  });

  test("asks the extension only after the page's own fetch fails", async () => {
    const requests = [];
    const bytes = await loadImageBytes("https://cdn.test/a.png", {width:1, height:1}, {
      fetchImpl:async () => { throw new TypeError("CORS"); },
      requestAsset:async (detail) => { requests.push(detail); return "data:image/png;base64,iVBORw0KGgo="; },
    });
    expect(requests).toEqual([{url:"https://cdn.test/a.png"}]);
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
  });

  test("rasterizes through the extension what the editor cannot decode", async () => {
    const requests = [];
    const bytes = await loadImageBytes("https://cdn.test/a.svg", {width:8, height:8}, {
      fetchImpl:async () => new Response(SVG),
      requestAsset:async (detail) => { requests.push(detail); return "data:image/png;base64,iVBORw0KGgo="; },
    });
    expect(requests[0].url).toStartWith("data:image/svg+xml;base64,");
    expect(requests[0].rasterize).toEqual({width:8, height:8});
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
  });

  test("asks the extension to bake color filters into an image", async () => {
    const asked = [];
    const bytes = await loadImageBytes("data:image/png;base64,iVBORw0KGgo=", {width:4, height:4, filter:"sepia(1)"}, {requestAsset:async (request) => { asked.push(request.rasterize); return "data:image/png;base64,iVBORw0KGgo="; }});
    expect(asked).toEqual([{width:4, height:4, filter:"sepia(1)"}]);
    expect(isEditorDecodableImage(bytes)).toBe(true);
  });

  // Security boundary: the offscreen canvas takes a filter string, and url() would reach outside.
  test("bakes only the color filters a capture produces", () => {
    expect(isBakedFilter("sepia(0.8) hue-rotate(90deg) contrast(120%)")).toBe(true);
    expect(isBakedFilter("grayscale(1) brightness(0.6)")).toBe(true);
    expect(isBakedFilter("url(https://evil.test/f.svg#x)")).toBe(false);
    expect(isBakedFilter("blur(2px)")).toBe(false);
    expect(isBakedFilter("sepia(1) url(#x)")).toBe(false);
  });

  test("rasterizes at twice the displayed size, keeping the source's proportions", () => {
    expect(rasterSize({width:24, height:24}, {width:96, height:96})).toEqual({width:192, height:192});
    expect(rasterSize({width:1000, height:500}, {width:100, height:100})).toEqual({width:1000, height:500});
    expect(rasterSize({width:0, height:0}, {width:50, height:20})).toEqual({width:100, height:40});
    expect(rasterSize({width:100, height:100}, {width:5000, height:5000})).toEqual({width:4096, height:4096});
  });
});

describe("capture shortcuts", () => {
  test("labels the platform modifier", () => {
    expect(pageCaptureModifier("MacIntel")).toBe("⌘");
    expect(pageCaptureModifier("Win32")).toBe("Ctrl");
  });

  test("distinguishes element and whole-page capture", () => {
    expect(isPageCaptureShortcut({ key:"Enter", metaKey:true, ctrlKey:false })).toBe(true);
    expect(isPageCaptureShortcut({ key:"Enter", metaKey:false, ctrlKey:false })).toBe(false);
  });
});

// Security boundary: a frame capture runs only in the asking tab, in the frame the request names.
describe("frame capture requests", () => {
  test("pass on only a well-formed place, area and size", () => {
    const valid = {path:[0, 2], clip:{left:0, top:0, right:100, bottom:50}, size:{width:100, height:80}};
    expect(frameRequest({...valid, extra:"ignored"})).toEqual(valid);
    for (const broken of [{path:[]}, {path:[-1]}, {path:[1.5]}, {path:"0"}, {path:Array(17).fill(0)}, {clip:{left:0, top:0, right:"1", bottom:2}}, {size:{width:Number.NaN, height:1}}]) {
      expect(frameRequest({...valid, ...broken})).toBeNull();
    }
  });

  test("name a frame by its index under each parent, from the top", () => {
    const top = {length:2};
    top.parent = top;
    const first = {parent:top, length:0};
    const second = {parent:top, length:1};
    const inner = {parent:second, length:0};
    Object.assign(top, {0:first, 1:second});
    second[0] = inner;
    expect(framePath(top)).toEqual([]);
    expect(framePath(inner)).toEqual([1, 0]);
    expect(framePath({parent:top})).toBeNull();
  });
});
