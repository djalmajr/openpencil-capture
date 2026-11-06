import { captureElementForOpenPencil } from "../openpencil-clipboard.mjs";
import { elementVisualSignature, waitForVisualStability } from "./visual-stability.mjs";

export async function captureSelectionInMainWorld(targetSelector, sourceSelector = targetSelector) {
  const target = document.querySelector(targetSelector);
  if (!(target instanceof Element)) throw new Error("The selected element is no longer available");
  await waitForVisualStability(() => elementVisualSignature(target));

  const { capture, html, converted, sceneRoot, missingImages } = await captureElementForOpenPencil(target, {
    selector: sourceSelector,
    url: globalThis.location.href,
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
