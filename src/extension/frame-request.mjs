export const FRAME_CAPTURE_MESSAGE = "openpencil-capture:capture-frame";

const isArea = (value, sides) => sides.every((side) => typeof value?.[side] === "number" && Number.isFinite(value[side]));

// A frame capture request as the service worker passes it on: the frame's place in the tab's
// frame tree, the part of its viewport that shows and the viewport's size; null if malformed.
export function frameRequest(message) {
  const path = Array.isArray(message?.path) && message.path.length > 0 && message.path.length <= 16
    && message.path.every((index) => Number.isInteger(index) && index >= 0) ? message.path.slice() : null;
  if (!path || !isArea(message.clip, ["left", "top", "right", "bottom"]) || !isArea(message.size, ["width", "height"])) return null;
  const {left, top, right, bottom} = message.clip;
  return {path, clip:{left, top, right, bottom}, size:{width:message.size.width, height:message.size.height}};
}

// A window's place in its tab: the index of each frame on the way down from the top. The browser
// keeps this tree, and an isolated world reads it the same in every frame.
export function framePath(view) {
  const path = [];
  for (let current = view; current !== current.parent; current = current.parent) {
    const siblings = current.parent;
    let index = -1;
    for (let at = 0; at < siblings.length; at += 1) {
      if (siblings[at] === current) {
        index = at;
        break;
      }
    }
    if (index < 0) return null;
    path.unshift(index);
  }
  return path;
}
