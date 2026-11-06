import { encodeBase64 } from "../base64.mjs";
import { isEditorDecodableImage } from "../load-image.mjs";

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

// A captured page chooses these URLs. Cookies stay out so its markup cannot read the user's data
// on other sites; images behind a login are fetched by the page itself instead.
export async function fetchExtensionAsset(url, options = {}) {
  const {protocol} = new URL(url);
  if (!["http:", "https:"].includes(protocol)) throw new Error(`Unsupported asset protocol: ${protocol}`);
  const response = await (options.fetchImpl || fetch)(url, {credentials:"omit", signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > MAX_ASSET_BYTES) throw new Error("The image is too large to embed");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!blob.type.startsWith("image/") && !isEditorDecodableImage(bytes)) throw new Error("The response is not an image");
  return `data:${blob.type || "application/octet-stream"};base64,${encodeBase64(bytes)}`;
}
