import { createEditor } from "@open-pencil/core/editor";
import { headlessRenderNodes, initCanvasKit } from "@open-pencil/core";
import { convertCaptureToTree } from "../../src/convert-capture.mjs";
import { loadImageBytes } from "../../src/load-image.mjs";
import { createClipboardFromTree } from "../../src/openpencil-clipboard.mjs";

export async function decodePng(png) {
  const canvasKit = await initCanvasKit();
  const image = canvasKit.MakeImageFromEncoded(png);
  const width = image.width();
  const height = image.height();
  const data = image.readPixels(0, 0, {width, height, colorType:canvasKit.ColorType.RGBA_8888, alphaType:canvasKit.AlphaType.Unpremul, colorSpace:canvasKit.ColorSpace.SRGB});
  image.delete();
  return {width, height, data};
}

// Pastes a capture into a headless editor; `render` draws the pasted root as the editor does.
export async function renderInEditor(capture) {
  const tree = convertCaptureToTree(capture);
  const {html} = await createClipboardFromTree(tree.root, {loadImage:(url, size) => loadImageBytes(url, size)});
  const editor = createEditor();
  const pageId = editor.state.currentPageId;
  await editor.pasteFromHTML(html);
  const [root] = editor.graph.getChildren(pageId);
  const flatten = (id) => editor.graph.getChildren(id).flatMap((node) => [node, ...flatten(node.id)]);
  return {tree, root, nodes:flatten(pageId), render:() => headlessRenderNodes(editor.graph, pageId, [root.id], {scale:1, format:"PNG"})};
}

const BLOCK = 4;

// Mean difference per channel, over 255, of two same-sized images composited on white and
// averaged over 4 × 4 blocks: antialiasing and image filtering differ between the engines, while
// geometry and color errors survive the averaging.
export function meanDifference(left, right) {
  if (left.width !== right.width || left.height !== right.height) return Infinity;
  const blocks = (image) => {
    const columns = Math.ceil(image.width / BLOCK);
    const sums = new Float64Array(columns * Math.ceil(image.height / BLOCK) * 4);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * 4;
        const alpha = image.data[index + 3] / 255;
        const block = (Math.floor(y / BLOCK) * columns + Math.floor(x / BLOCK)) * 4;
        for (let channel = 0; channel < 3; channel += 1) sums[block + channel] += image.data[index + channel] * alpha + 255 * (1 - alpha);
        sums[block + 3] += 1;
      }
    }
    return sums;
  };
  const a = blocks(left);
  const b = blocks(right);
  let total = 0;
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) total += Math.abs(a[index + channel] - b[index + channel]) / a[index + 3];
    count += 3;
  }
  return total / count / 255;
}
