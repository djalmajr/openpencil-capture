import { encodeBase64 } from "./base64.mjs";

const ASSET_REQUEST_EVENT = "openpencil-capture:asset-request";
const ASSET_RESPONSE_EVENT = "openpencil-capture:asset-response";
const ASSET_TIMEOUT_MS = 30_000;

export function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) throw new TypeError("Not a data URL");
  const payload = url.slice(comma + 1);
  if (url.slice(0, comma).includes(";base64")) {
    return Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

// Browsers sniff raster formats whatever the image/* label says, but only load SVG when told.
function encodeDataUrl(bytes) {
  const isMarkup = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().startsWith("<");
  return `data:${isMarkup ? "image/svg+xml" : "image/png"};base64,${encodeBase64(bytes)}`;
}

// CanvasKit decodes only these. SVG, AVIF and the rest have to reach the editor as a bitmap.
export function isEditorDecodableImage(bytes) {
  const startsWith = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47) || startsWith(0xff, 0xd8, 0xff) || startsWith(0x47, 0x49, 0x46)) return true;
  return startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function requestExtensionAsset(detail) {
  if (!globalThis.document?.documentElement.hasAttribute("data-openpencil-capture-extension")) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(null), ASSET_TIMEOUT_MS);
    const onResponse = (event) => {
      let response;
      try { response = JSON.parse(event.detail); } catch { return; }
      if (response?.id === id) finish(response.dataUrl || null);
    };
    const finish = (value) => {
      clearTimeout(timeout);
      globalThis.removeEventListener(ASSET_RESPONSE_EVENT, onResponse);
      resolve(value);
    };
    globalThis.addEventListener(ASSET_RESPONSE_EVENT, onResponse);
    globalThis.dispatchEvent(new CustomEvent(ASSET_REQUEST_EVENT, {detail:JSON.stringify({id, ...detail})}));
  });
}

async function fetchBytes(url, fetchImpl) {
  if (url.startsWith("data:")) return decodeDataUrl(url);
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    // The page is bound by CORS; the extension's own fetch is not.
    const dataUrl = await requestExtensionAsset({url});
    return dataUrl ? decodeDataUrl(dataUrl) : null;
  }
}

export async function loadImageBytes(url, size, options = {}) {
  const bytes = await fetchBytes(url, options.fetchImpl || globalThis.fetch);
  if (!bytes || isEditorDecodableImage(bytes)) return bytes;
  const rasterized = await requestExtensionAsset({url:encodeDataUrl(bytes), rasterize:size});
  return rasterized ? decodeDataUrl(rasterized) : null;
}
