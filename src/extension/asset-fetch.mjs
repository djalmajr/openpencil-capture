import { encodeBase64 } from "../base64.mjs";

export async function fetchExtensionAsset(url, options = {}) {
  const response = await (options.fetchImpl || fetch)(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return `data:${blob.type || "application/octet-stream"};base64,${encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}
