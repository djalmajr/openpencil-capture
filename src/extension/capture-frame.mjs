import { captureElement } from "../capture-element.mjs";

import { FRAME_CAPTURE_MESSAGE, framePath } from "./frame-request.mjs";
const FRAME_CAPTURE_TIMEOUT_MS = 20_000;

// Extensions may read closed shadow roots too: what they hold is on screen like the rest. The API
// takes HTML elements only; it throws for SVG ones, which have no shadow root anyway. The
// namespace, unlike instanceof, also holds for elements of a same-origin frame's document.
export const extensionShadowRoot = (element) => element.namespaceURI === "http://www.w3.org/1999/xhtml" && globalThis.chrome?.dom?.openOrClosedShadowRoot
  ? globalThis.chrome.dom.openOrClosedShadowRoot(element) ?? null
  : element.shadowRoot ?? null;

/**
 * A frame of another origin, captured in its own document by this extension's script there. The
 * frame is named by its place in the tab's frame tree and reached through the service worker, so
 * no message crosses the page: neither the page nor the frame's scripts can see or answer it.
 */
export async function captureFrameThroughExtension(element, request) {
  const view = element.ownerDocument.defaultView;
  const own = framePath(view);
  const frames = view.frames;
  let index = -1;
  for (let at = 0; at < frames.length; at += 1) {
    if (frames[at] === element.contentWindow) {
      index = at;
      break;
    }
  }
  if (!own || index < 0) return null;
  const size = {width:element.clientWidth - px(element, "paddingLeft") - px(element, "paddingRight"), height:element.clientHeight - px(element, "paddingTop") - px(element, "paddingBottom")};
  let timeout;
  const timedOut = new Promise((resolve) => { timeout = setTimeout(() => resolve(null), FRAME_CAPTURE_TIMEOUT_MS); });
  const asked = chrome.runtime.sendMessage({type:FRAME_CAPTURE_MESSAGE, path:[...own, index], clip:request.clip, size})
    .then((response) => response?.ok ? response.capture : null)
    .catch(() => null);
  return Promise.race([asked, timedOut]).finally(() => clearTimeout(timeout));
}

const px = (element, key) => Number.parseFloat(element.ownerDocument.defaultView.getComputedStyle(element)[key]) || 0;

/**
 * What the service worker calls in every frame of the tab: only the frame at `path`, whose
 * viewport is the size its <iframe> shows, captures its document, within `clip`, and the frames
 * of other origins inside it the same way. The others answer null.
 */
export function captureThisFrame({path, clip, size}) {
  const own = framePath(globalThis);
  if (!own || own.length !== path.length || own.some((index, at) => index !== path[at])) return null;
  if (Math.abs(globalThis.innerWidth - size.width) > 1 || Math.abs(globalThis.innerHeight - size.height) > 1) return null;
  return captureElement(globalThis.document.documentElement, {
    frame:{clip}, url:globalThis.location.href,
    shadowRootOf:extensionShadowRoot, captureFrame:captureFrameThroughExtension,
    ignore:(element) => element === globalThis.__openPencilCaptureHost,
  });
}
