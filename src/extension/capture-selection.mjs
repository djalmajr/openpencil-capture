import { captureElementForOpenPencil } from "../openpencil-clipboard.mjs";
import { elementVisualSignature, waitForVisualStability } from "./visual-stability.mjs";

export async function captureSelection(target, sourceSelector, options = {}) {
  await waitForVisualStability(() => elementVisualSignature(target));

  const { capture, html, converted, sceneRoot, missingImages } = await captureElementForOpenPencil(target, {
    selector: sourceSelector,
    url: globalThis.location.href,
    requestAsset: options.requestAsset,
    // Extensions may read closed shadow roots too: what they hold is on screen like the rest.
    shadowRootOf: (element) => globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot,
  });
  const countNodes = (node) => 1 + (node.children || []).reduce((total, child) => total + countNodes(child), 0);
  const capturedTags = Object.fromEntries(Object.entries(capture.nodes.reduce((counts, node) => {
    counts[node.tag] = (counts[node.tag] || 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right)));
  const convertedTags = {};
  const countConvertedTags = (node) => {
    convertedTags[node.type] = (convertedTags[node.type] || 0) + 1;
    for (const child of node.children || []) countConvertedTags(child);
  };
  countConvertedTags(sceneRoot);
  return {
    html,
    nodeCount:countNodes(sceneRoot),
    name:sceneRoot.name,
    stats:converted.stats,
    capturedTags,
    convertedTags,
    missingImages,
  };
}
