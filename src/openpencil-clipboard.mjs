import { computeImageHash } from "@open-pencil/scene-graph/images";
import { deflateSync } from "fflate";
import { encodeBase64 } from "./base64.mjs";
import { captureElement } from "./capture-element.mjs";
import { convertCaptureToTree } from "./convert-capture.mjs";
import { loadImageBytes } from "./load-image.mjs";
import { collectImageRequests, toSceneNodes } from "./scene-nodes.mjs";

export const OPENPENCIL_CLIPBOARD_FORMAT = "openpencil/v1";

/**
 * The HTML must stay exactly this comment. WebKit strips comments from HTML another app wrote,
 * which leaves the desktop app with an empty `text/html` and sends it to the plain-text route;
 * anything else in the markup would survive sanitizing and block that route.
 */
export function createOpenPencilClipboardHtml(nodes, images = new Map()) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new TypeError("OpenPencil clipboard data requires at least one node");
  }
  const data = {
    format:OPENPENCIL_CLIPBOARD_FORMAT,
    nodes,
    images:Object.fromEntries(Array.from(images, ([hash, bytes]) => [hash, encodeBase64(bytes)])),
  };
  return `<!--(openpencil)${encodeBase64(deflateSync(new TextEncoder().encode(JSON.stringify(data))))}(/openpencil)-->`;
}

export async function loadTreeImages(root, loadImage) {
  const images = new Map();
  const hashes = new Map();
  const missing = [];
  await Promise.all(Array.from(collectImageRequests(root), async ([url, size]) => {
    const bytes = await loadImage(url, size).catch(() => null);
    if (!bytes) {
      missing.push(url);
      return;
    }
    const hash = computeImageHash(bytes);
    images.set(hash, bytes);
    hashes.set(url, hash);
  }));
  return {images, hashes, missing};
}

export async function createClipboardFromTree(root, options = {}) {
  const loadImage = options.loadImage || ((url, size) => loadImageBytes(url, size, {requestAsset:options.requestAsset}));
  const {images, hashes, missing} = await loadTreeImages(root, loadImage);
  const sceneRoot = toSceneNodes(root, hashes);
  return {sceneRoot, missingImages:missing, html:createOpenPencilClipboardHtml([sceneRoot], images)};
}

export async function captureElementForOpenPencil(element, options = {}) {
  const capture = captureElement(element, options);
  const converted = convertCaptureToTree(capture);
  return {capture, converted, ...await createClipboardFromTree(converted.root, options)};
}
