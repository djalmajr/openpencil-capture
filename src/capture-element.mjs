export const CAPTURE_FORMAT = "openpencil-capture-ir";
export const CAPTURE_VERSION = 1;

export const CAPTURED_STYLE_KEYS = [
  "display", "position", "flexDirection", "alignItems", "justifyContent", "gap",
  "backgroundColor", "backgroundImage", "color",
  "backgroundPosition", "backgroundPositionX", "backgroundPositionY", "backgroundRepeat", "backgroundSize", "backgroundOrigin", "backgroundClip",
  "overflowX", "overflowY", "contentVisibility",
  "borderTopColor", "borderTopWidth", "borderTopStyle",
  "borderRightColor", "borderRightWidth", "borderRightStyle",
  "borderBottomColor", "borderBottomWidth", "borderBottomStyle",
  "borderLeftColor", "borderLeftWidth", "borderLeftStyle",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
  "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "textAlign", "textTransform", "whiteSpaceCollapse", "tabSize", "textDecorationLine", "textDecorationColor", "textDecorationThickness", "textUnderlineOffset", "whiteSpace", "textOverflow", "webkitLineClamp", "webkitBoxOrient", "opacity", "overflow", "visibility", "boxShadow",
  "objectFit", "objectPosition", "filter", "backdropFilter", "mixBlendMode",
  "fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeDasharray", "strokeDashoffset", "strokeLinecap", "strokeLinejoin",
  "stopColor", "stopOpacity",
];

const CAPTURED_ATTRIBUTES = new Set([
  "aria-label", "aria-valuenow", "data-slot", "type", "src", "alt", "href",
  "placeholder", "min", "max", "step",
  "d", "fill", "stroke", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
  "cx", "cy", "r", "rx", "ry", "points", "viewBox", "preserveAspectRatio", "text-anchor",
  "id", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "fx", "fy",
]);

function nearestOpaqueBackground(node) {
  for (let current = node; current instanceof Element; current = current.parentElement) {
    const color = getComputedStyle(current).backgroundColor;
    const alpha = color?.match(/rgba?\([^)]*[,/]\s*([\d.]+)\s*\)$/i)?.[1];
    if (color && color !== "transparent" && Number(alpha ?? 1) > 0) return color;
  }
  return "rgb(255, 255, 255)";
}

function canvasSnapshot(node) {
  const output = document.createElement("canvas");
  output.width = node.width;
  output.height = node.height;
  const context = output.getContext("2d");
  context.fillStyle = nearestOpaqueBackground(node);
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(node, 0, 0);
  return output.toDataURL("image/png");
}

export function effectiveFilter(node, root, styleOf = getComputedStyle) {
  const filters = [];
  for (let current = node; current; current = current.parentElement) {
    const filter = styleOf(current).filter;
    if (filter && filter !== "none") filters.push(filter);
    if (current === root) break;
  }
  return filters.join(" ") || "none";
}

const maskText = (value) => value.replace(/\S/g, "•");

function isMaskedByCss(computed) {
  return Boolean(computed.webkitTextSecurity) && computed.webkitTextSecurity !== "none";
}

function maskSnapshot(snapshot) {
  return {
    ...snapshot,
    text:snapshot.text && maskText(snapshot.text),
    textRuns:snapshot.textRuns.map((run) => ({...run, text:maskText(run.text)})),
  };
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont"]);
const FONT_PROBE = "mmmmmmmmmlli1WQ@#&";

function fontFamilies(value) {
  return String(value || "").split(",").map((family) => family.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

// The first family in `font-family` the browser can draw with: an unavailable one falls back, so
// text measured with a fallback set as its own family keeps the fallback's width.
// Measured in the node's own document, which holds its @font-face rules, and on its own text, so a
// font limited by `unicode-range` counts only where it covers that text.
function availableFamily(computed, cache, node, sample) {
  const families = fontFamilies(computed.fontFamily);
  const probe = String(sample || "").trim().slice(0, 64) || FONT_PROBE;
  const context = node.ownerDocument.createElement("canvas").getContext("2d");
  if (!context) return families[0] || null;
  for (const family of families) {
    if (GENERIC_FAMILIES.has(family.toLowerCase())) return family;
    const key = `${computed.fontStyle} ${computed.fontWeight} ${family} ${probe}`;
    if (!cache.has(key)) {
      const quoted = `"${family.replace(/["\\]/g, "\\$&")}"`;
      cache.set(key, ["monospace", "serif", "sans-serif"].some((fallback) => {
        context.font = `${computed.fontStyle} ${computed.fontWeight} 72px ${fallback}`;
        const base = context.measureText(probe).width;
        context.font = `${computed.fontStyle} ${computed.fontWeight} 72px ${quoted}, ${fallback}`;
        return context.measureText(probe).width !== base;
      }));
    }
    if (cache.get(key)) return family;
  }
  return families.at(-1) || null;
}

function ellipsisWidth(computed) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return Number.parseFloat(computed.fontSize) * 0.75;
  context.font = computed.font || `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  return context.measureText("...").width;
}

// `origin` is where the node's document places the root: the root's own corner, minus the offset
// of any iframes in between. `clip`, in the node's own viewport, is what of its content shows: a
// character outside it is left out, as the page does not draw it.
function directTextSnapshot(node, origin, computed, childNodes, clip) {
  const rootRect = origin;
  const nodeRect = node.getBoundingClientRect();
  const textNodes = childNodes.filter((child) => child.nodeType === 3 && child.textContent?.trim());
  const lines = [];
  for (const [sourceIndex, textNode] of textNodes.entries()) {
    for (let index = 0; index < textNode.length; index += 1) {
      const range = node.ownerDocument.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      let line = lines.find((candidate) => candidate.sourceIndex === sourceIndex && Math.abs(candidate.top - rect.top) <= 1);
      if (!line) {
        line = {top:rect.top,sourceIndex,entries:[]};
        lines.push(line);
      }
      line.entries.push({character:textNode.data[index],rect});
    }
  }
  lines.sort((left, right) => left.top - right.top || left.entries[0]?.rect.left - right.entries[0]?.rect.left);
  // `pre`, `pre-wrap` and `break-spaces` show every space; elsewhere runs of them collapse.
  const keepsSpaces = /^(pre|pre-wrap|break-spaces)$/.test(computed.whiteSpace) || computed.whiteSpaceCollapse === "preserve" || computed.whiteSpaceCollapse === "break-spaces";
  for (const line of lines) {
    if (keepsSpaces) {
      while (line.entries.length && /[\n\r]/.test(line.entries.at(-1).character)) line.entries.pop();
      continue;
    }
    while (line.entries.length && /\s/.test(line.entries[0].character)) line.entries.shift();
    while (line.entries.length && /\s/.test(line.entries.at(-1).character)) line.entries.pop();
  }
  const populatedLines = lines.filter((line) => line.entries.length);
  const lineClamp = Number.parseInt(computed.webkitLineClamp, 10);
  const clipsOverflow = ["hidden", "clip"].includes(computed.overflow);
  const clampsLines = clipsOverflow && Number.isFinite(lineClamp) && lineClamp > 0;
  let visibleLines = populatedLines;
  let truncated = false;
  if (clampsLines) {
    const onscreenLines = populatedLines
      .filter((line) => line.entries.some((entry) => entry.rect.bottom > nodeRect.top && entry.rect.top < nodeRect.bottom - 0.5));
    const visibleTops = [];
    for (const line of onscreenLines) {
      if (visibleTops.some((top) => Math.abs(top - line.top) <= 1)) continue;
      if (visibleTops.length === lineClamp) break;
      visibleTops.push(line.top);
    }
    visibleLines = onscreenLines.filter((line) => visibleTops.some((top) => Math.abs(top - line.top) <= 1));
    truncated = visibleLines.length < populatedLines.length;
  } else if (clipsOverflow && computed.textOverflow === "ellipsis" && computed.whiteSpace === "nowrap" && node.scrollWidth > node.clientWidth + 0.5) {
    const availableRight = nodeRect.right - ellipsisWidth(computed);
    visibleLines = populatedLines.slice(0, 1).map((line) => {
      const entries = line.entries.filter((entry) => entry.rect.left < availableRight);
      truncated = entries.length < line.entries.length;
      return {...line,entries};
    });
  }
  const inside = ({rect}) => {
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    return x > clip.left && x < clip.right && y > clip.top && y < clip.bottom;
  };
  const runs = visibleLines.flatMap((line, index) => {
    line = {...line, entries:line.entries.filter(inside)};
    if (!keepsSpaces) {
      while (line.entries.length && /\s/.test(line.entries[0].character)) line.entries.shift();
      while (line.entries.length && /\s/.test(line.entries.at(-1).character)) line.entries.pop();
    }
    if (!line.entries.length) return [];
    const tabSpaces = " ".repeat(Number.parseInt(computed.tabSize, 10) || 8);
    let text = line.entries.map((entry) => entry.character).join("");
    text = keepsSpaces ? text.replace(/\t/g, tabSpaces).replace(/[\n\r]/g, "") : text.replace(/\s+/g, " ");
    if (truncated && index === visibleLines.length - 1) text = `${text.replace(/[.\s]+$/g, "")}...`;
    const left = Math.min(...line.entries.map((entry) => entry.rect.left));
    const top = Math.min(...line.entries.map((entry) => entry.rect.top));
    const right = Math.max(...line.entries.map((entry) => entry.rect.right));
    const bottom = Math.max(...line.entries.map((entry) => entry.rect.bottom));
    return [{text,rect:{x:left-rootRect.x,y:top-rootRect.y,width:right-left,height:bottom-top}}];
  });
  return textFromRuns(runs);
}

function textFromRuns(runs) {
  if (!runs.length) return {text:null,textRect:null,textRuns:[]};
  const left = Math.min(...runs.map((run) => run.rect.x));
  const top = Math.min(...runs.map((run) => run.rect.y));
  const right = Math.max(...runs.map((run) => run.rect.x + run.rect.width));
  const bottom = Math.max(...runs.map((run) => run.rect.y + run.rect.height));
  return {
    text:runs.map((run) => run.text).join(" "),
    textRect:{x:left,y:top,width:right-left,height:bottom-top},
    textRuns:runs,
  };
}

// Content the page does not render never enters a capture, since a capture may end up in a shared
// design file: `display:none`, `content-visibility:hidden` (a closed `<details>`, `hidden=until-found`)
// and `opacity:0` hide a whole subtree. SVG resources are never rendered in place, and still paint.
const SVG_RESOURCES = new Set(["defs", "lineargradient", "radialgradient", "pattern", "symbol", "clippath", "mask", "filter", "marker"]);
const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "auto", "scroll"]);

// `display:contents` (every <slot>, by default) has no box of its own, so checkVisibility() says
// no while its children show; only its opacity can hide them.
function isRendered(node) {
  if (typeof node.checkVisibility !== "function") return true;
  const view = node.ownerDocument.defaultView;
  let box = node;
  while (box && view.getComputedStyle(box).display === "contents") box = box.parentElement || box.getRootNode().host || null;
  return box ? box.checkVisibility({opacityProperty:true}) : true;
}

const PSEUDO_INPUT_TYPES = new Set(["checkbox", "radio", "range", "color", "file", "date", "time", "month", "week", "datetime-local"]);
const REPLACED_ELEMENTS = new Set(["img", "input", "textarea", "select", "video", "audio", "iframe", "frame", "canvas", "embed", "object", "br", "hr"]);
const shift = (rect, x, y) => ({left:rect.left + x, right:rect.right + x, top:rect.top + y, bottom:rect.bottom + y});

const isClear = (color) => !color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);

// The background of a document's canvas: the root element's, or the body's when the root has none.
// CSS paints it over the whole viewport instead of the element's own box.
function canvasBackground(document) {
  const html = document.documentElement;
  const body = document.body;
  const htmlStyle = html && document.defaultView.getComputedStyle(html);
  if (htmlStyle && (!isClear(htmlStyle.backgroundColor) || htmlStyle.backgroundImage !== "none")) return {element:html, color:isClear(htmlStyle.backgroundColor) ? null : htmlStyle.backgroundColor};
  const bodyStyle = body && document.defaultView.getComputedStyle(body);
  if (bodyStyle && (!isClear(bodyStyle.backgroundColor) || bodyStyle.backgroundImage !== "none")) return {element:body, color:isClear(bodyStyle.backgroundColor) ? null : bodyStyle.backgroundColor};
  return null;
}

// A sliver of a pixel or less shows nothing anyone can read.
function intersects(box, clip) {
  return Math.min(box.right, clip.right) - Math.max(box.left, clip.left) > 1
    && Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top) > 1;
}

// Descendants are clipped to the padding box of an ancestor whose overflow is not visible.
function contentClip(computed, box, clip) {
  const left = box.left + Number.parseFloat(computed.borderLeftWidth || 0);
  const right = box.right - Number.parseFloat(computed.borderRightWidth || 0);
  const top = box.top + Number.parseFloat(computed.borderTopWidth || 0);
  const bottom = box.bottom - Number.parseFloat(computed.borderBottomWidth || 0);
  const clipsX = CLIPPING_OVERFLOW.has(computed.overflowX);
  const clipsY = CLIPPING_OVERFLOW.has(computed.overflowY);
  return {
    left:clipsX ? Math.max(clip.left, left) : clip.left,
    right:clipsX ? Math.min(clip.right, right) : clip.right,
    top:clipsY ? Math.max(clip.top, top) : clip.top,
    bottom:clipsY ? Math.min(clip.bottom, bottom) : clip.bottom,
  };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const styleOf = (node, pseudo) => node.ownerDocument.defaultView.getComputedStyle(node, pseudo);

// The tree the page renders: a shadow host shows its shadow root, a slot what is assigned to it.
function flatChildNodes(node, shadowRootOf) {
  const shadow = shadowRootOf(node);
  if (shadow) return Array.from(shadow.childNodes);
  if (node.localName === "slot" && typeof node.assignedNodes === "function") {
    const assigned = node.assignedNodes();
    if (assigned.length) return assigned;
  }
  return Array.from(node.childNodes);
}

// A same-origin frame's document; reading a cross-origin one throws or gives null.
function frameDocument(node) {
  if (!["iframe", "frame"].includes(node.localName)) return null;
  try { return node.contentDocument?.documentElement ? node.contentDocument : null; } catch { return null; }
}

const matrixOf = (matrix) => [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map((value) => Number(value.toFixed(6)));
const isIdentity = ([a, b, c, d, e, f]) => a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;

// From a graphic's own coordinates to its SVG's viewBox: the transforms of the graphic and of every
// group between them.
function svgTransform(node) {
  const svg = node.ownerSVGElement;
  if (!svg || typeof node.getScreenCTM !== "function") return null;
  const own = node.getScreenCTM();
  const outer = svg.getScreenCTM();
  if (!own || !outer) return null;
  const matrix = matrixOf(outer.inverse().multiply(own));
  return isIdentity(matrix) ? null : matrix;
}

const multiplyMatrices = ([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) => [
  a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
];

function ownTransform(element) {
  const consolidated = element.transform?.baseVal?.consolidate?.();
  return consolidated ? matrixOf(consolidated.matrix) : [1, 0, 0, 1, 0, 0];
}

function useTarget(node) {
  const href = node.getAttribute("href") || node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (!href?.startsWith("#")) return null;
  const id = href.slice(1);
  return node.getRootNode().getElementById?.(id) || node.ownerDocument.getElementById(id);
}

// Properties a referenced element inherits from the <use> that shows it, not from where it sits.
const INHERITED_SVG_STYLES = ["fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeDasharray", "strokeDashoffset", "strokeLinecap", "strokeLinejoin", "color", "visibility"];

// Nothing reports where a pseudo-element is drawn. A positioned one is placed from its containing
// block with the pixels the browser resolves for `left`, `top` and its size, plus the translation
// of its transform; an inline one has no such numbers and is left out.
function pseudoBox(node, computed) {
  if (!["absolute", "fixed"].includes(computed.position)) return null;
  const view = node.ownerDocument.defaultView;
  const number = (value) => Number.parseFloat(value) || 0;
  // The containing block: the nearest box that is positioned (for absolute) or that transforms,
  // filters or contains its descendants (for both); without one, the page or the viewport.
  const fixed = computed.position === "fixed";
  let block = null;
  for (let element = node; element; element = element.parentElement || element.getRootNode().host || null) {
    const style = view.getComputedStyle(element);
    const traps = style.transform !== "none" || style.filter !== "none" || style.perspective !== "none" || style.backdropFilter !== "none"
      || /paint|layout|strict|content/.test(style.contain || "") || /transform|filter|perspective/.test(style.willChange || "");
    if (traps || (!fixed && style.position !== "static")) {
      block = element;
      break;
    }
  }
  let origin = fixed ? {x:0, y:0} : {x:-view.scrollX, y:-view.scrollY};
  if (block) {
    const rect = block.getBoundingClientRect();
    origin = {x:rect.left + block.clientLeft, y:rect.top + block.clientTop};
  }
  const extraX = computed.boxSizing === "border-box" ? 0 : ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((total, key) => total + number(computed[key]), 0);
  const extraY = computed.boxSizing === "border-box" ? 0 : ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((total, key) => total + number(computed[key]), 0);
  const width = number(computed.width) + extraX;
  const height = number(computed.height) + extraY;
  if (!(width > 0 && height > 0)) return null;
  const translation = computed.transform?.match(/^matrix\(([^)]+)\)$/)?.[1].split(",").map(Number) || [1, 0, 0, 1, 0, 0];
  const x = origin.x + number(computed.left) + number(computed.marginLeft) + translation[4];
  const y = origin.y + number(computed.top) + number(computed.marginTop) + translation[5];
  return {x, y, width, height, left:x, top:y, right:x + width, bottom:y + height};
}

const IMAGE_MEASURE_TIMEOUT_MS = 3000;

// Where a background image lands depends on its natural size, which only the page knows. The
// browser has already loaded each one, so this mostly reads its cache.
async function measureBackgroundImages(nodes) {
  const urls = new Set();
  for (const node of nodes) {
    for (const match of String(node.styles.backgroundImage || "").matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\)/gi)) {
      urls.add(match.slice(1).find(Boolean));
    }
  }
  const sizes = {};
  await Promise.all(Array.from(urls, (url) => new Promise((resolve) => {
    const image = new Image();
    const done = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) sizes[url] = {width:image.naturalWidth, height:image.naturalHeight};
      resolve();
    };
    image.onload = done;
    image.onerror = done;
    setTimeout(done, IMAGE_MEASURE_TIMEOUT_MS);
    image.src = url;
  })));
  return sizes;
}

export async function captureElement(root, options = {}) {
  if (typeof Element === "undefined" || !(root instanceof Element)) {
    throw new TypeError("captureElement expects a DOM Element");
  }
  if (!isRendered(root)) throw new Error("The selected element is not visible");
  const rootRect = root.getBoundingClientRect();
  // The page's canvas starts at the document origin: anything left of or above it cannot be seen.
  const view = root.ownerDocument.defaultView;
  const nodes = [];
  const fontCache = new Map();
  const shadowRootOf = options.shadowRootOf || ((element) => element.shadowRoot);
  const rectIn = (raw, offset) => ({x:raw.x + offset.x - rootRect.x, y:raw.y + offset.y - rootRect.y, width:raw.width, height:raw.height});
  const visit = (node, path, parentPath, context) => {
    const tag = node.localName;
    const isSvg = node.namespaceURI === SVG_NAMESPACE;
    const inResources = context.inResources || (isSvg && SVG_RESOURCES.has(tag.toLowerCase()));
    if (node !== root && !inResources && !isRendered(node)) return;
    if (isSvg && tag === "use" && !inResources) return visitUse(node, path, parentPath, context);
    const {offset} = context;
    const raw = node.getBoundingClientRect();
    const box = {left:raw.left + offset.x, top:raw.top + offset.y, right:raw.right + offset.x, bottom:raw.bottom + offset.y};
    const computed = styleOf(node);
    const clip = computed.position === "fixed" ? context.canvas : context.clip;
    // `content-visibility:hidden` renders the element's box and skips everything inside it.
    const shown = !inResources && computed.visibility === "visible" && computed.contentVisibility !== "hidden";
    const masked = isMaskedByCss(computed);
    // A closed <details> renders its first <summary> and nothing else, text included.
    const closedDetails = node.localName === "details" && !node.open;
    const childNodes = closedDetails
      ? Array.from(node.children).filter((child) => child.localName === "summary").slice(0, 1)
      : flatChildNodes(node, shadowRootOf);
    const ownClip = contentClip(computed, box, clip);
    const snapshot = shown
      ? directTextSnapshot(node, {x:rootRect.x - offset.x, y:rootRect.y - offset.y}, computed, childNodes, shift(ownClip, -offset.x, -offset.y))
      : textFromRuns([]);
    const { text, textRect, textRuns } = masked ? maskSnapshot(snapshot) : snapshot;
    const attributes = Object.fromEntries(Array.from(node.attributes)
      .filter((attribute) => CAPTURED_ATTRIBUTES.has(attribute.name))
      .map((attribute) => [attribute.name, attribute.value]));
    if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) {
      // A value is kept only if it can be seen: masked values stay bullets, and a control that is
      // hidden, clipped away, off the canvas or shrunk to a pixel keeps its value out.
      const rendered = shown && intersects(box, clip);
      if (rendered && (node.type === "password" || masked)) attributes.maskedValue = "•".repeat(node.value.length);
      else if (rendered && node.type !== "hidden") attributes.value = node.value;
      attributes.disabled = node.disabled;
      if ("checked" in node) attributes.checked = node.checked;
      if (node.tagName === "SELECT" && rendered && !masked) attributes.selectedLabel = node.selectedOptions[0]?.textContent?.trim() || "";
    }
    if (node.tagName === "CANVAS") {
      try { attributes.dataUrl = canvasSnapshot(node); } catch { attributes.dataUrl = null; }
    }
    if (node.tagName === "IMG") {
      attributes.effectiveFilter = effectiveFilter(node, root, styleOf);
      attributes.currentSrc = node.currentSrc || node.src || attributes.src || null;
      attributes.naturalWidth = node.naturalWidth;
      attributes.naturalHeight = node.naturalHeight;
    }
    if (["INPUT", "TEXTAREA"].includes(node.tagName) && attributes.placeholder) {
      const placeholder = styleOf(node, "::placeholder");
      attributes.placeholderColor = placeholder.color;
      attributes.placeholderOpacity = placeholder.opacity;
    }
    if (isSvg && !inResources) {
      const transform = svgTransform(node);
      if (transform) attributes.transformMatrix = transform;
    }
    if (context.propagated === node) attributes.backgroundPropagated = true;
    const frame = frameDocument(node);
    const frameCanvas = frame && shown && canvasBackground(frame);
    if (frameCanvas?.color) attributes.canvasBackground = frameCanvas.color;
    nodes.push({
      path, parentPath, tag: node.tagName.toLowerCase(), namespace: node.namespaceURI,
      role: node.getAttribute("role"),
      name: node.getAttribute("data-slot") || node.getAttribute("aria-label") || text || node.tagName.toLowerCase(),
      text, textRect, textRuns,
      ...(text || attributes.value || attributes.placeholder || attributes.maskedValue ? {fontFamily:availableFamily(computed, fontCache, node, text || attributes.value || attributes.placeholder)} : {}),
      rect: rectIn(raw, offset),
      styles: Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, computed[key]])),
      attributes,
    });
    // `visibility` does not inherit into a frame's document, so a hidden frame hides it here.
    if (frame && shown) {
      // A frame's document lays out in its own viewport, which starts at the frame's content box.
      const left = box.left + node.clientLeft + Number.parseFloat(computed.paddingLeft || 0);
      const top = box.top + node.clientTop + Number.parseFloat(computed.paddingTop || 0);
      const viewport = {left, top, right:left + node.clientWidth - Number.parseFloat(computed.paddingLeft || 0) - Number.parseFloat(computed.paddingRight || 0), bottom:top + node.clientHeight - Number.parseFloat(computed.paddingTop || 0) - Number.parseFloat(computed.paddingBottom || 0)};
      const frameClip = {left:Math.max(clip.left, viewport.left), top:Math.max(clip.top, viewport.top), right:Math.min(clip.right, viewport.right), bottom:Math.min(clip.bottom, viewport.bottom)};
      visit(frame.documentElement, `${path}.0`, path, {inResources:false, offset:{x:left, y:top}, clip:frameClip, canvas:frameClip, propagated:frameCanvas?.element});
      return;
    }
    if (frame) return;
    const childContext = {...context, inResources, clip:ownClip};
    // Pseudo-elements are part of the content `content-visibility:hidden` skips; replaced elements
    // such as <img> and <input> draw none.
    // Chromium draws them on the inputs it renders as widgets, whatever their `appearance`, and on
    // no text-like input (measured).
    const replaced = tag === "input" ? !PSEUDO_INPUT_TYPES.has(node.type) : REPLACED_ELEMENTS.has(tag);
    const drawsPseudo = !isSvg && !inResources && computed.contentVisibility !== "hidden" && !closedDetails && !replaced;
    if (drawsPseudo) visitPseudo(node, "::before", path, childContext);
    childNodes.filter((child) => child.nodeType === 1).forEach((child, index) => visit(child, `${path}.${index}`, path, childContext));
    if (drawsPseudo) visitPseudo(node, "::after", path, childContext);
  };

  const visitPseudo = (node, pseudo, parentPath, context) => {
    const computed = styleOf(node, pseudo);
    if (!computed || computed.content === "none" || computed.content === "normal" || computed.display === "none") return;
    if (computed.visibility !== "visible" || Number.parseFloat(computed.opacity) === 0) return;
    const raw = pseudoBox(node, computed);
    if (!raw) return;
    const box = {left:raw.left + context.offset.x, top:raw.top + context.offset.y, right:raw.right + context.offset.x, bottom:raw.bottom + context.offset.y};
    if (!intersects(box, computed.position === "fixed" ? context.canvas : context.clip)) return;
    const rect = rectIn(raw, context.offset);
    // Only quoted text: counters, attr() and images have no string the capture can trust.
    const literal = computed.content.match(/^"((?:[^"\\]|\\.)*)"$/)?.[1]?.replace(/\\(.)/g, "$1").trim();
    const quoted = literal && isMaskedByCss(computed) ? maskText(literal) : literal;
    const number = (value) => Number.parseFloat(value) || 0;
    const textRect = quoted ? {
      x:rect.x + number(computed.borderLeftWidth) + number(computed.paddingLeft), y:rect.y + number(computed.borderTopWidth) + number(computed.paddingTop),
      width:Math.max(1, rect.width - number(computed.borderLeftWidth) - number(computed.borderRightWidth) - number(computed.paddingLeft) - number(computed.paddingRight)),
      height:Math.max(1, rect.height - number(computed.borderTopWidth) - number(computed.borderBottomWidth) - number(computed.paddingTop) - number(computed.paddingBottom)),
    } : null;
    nodes.push({
      path:`${parentPath}.${pseudo.slice(2)}`, parentPath, tag:pseudo, namespace:"http://www.w3.org/1999/xhtml", role:null,
      name:pseudo, text:quoted || null, textRect, textRuns:[],
      ...(quoted ? {fontFamily:availableFamily(computed, fontCache, node, literal)} : {}),
      rect, styles:Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, computed[key]])), attributes:{}, synthetic:"pseudo",
    });
  };

  // A <use> shows a copy of what it references, which the page renders in a shadow tree nobody can
  // read. The capture rebuilds that copy as an <svg> viewport holding the referenced graphics, each
  // with its transform into that viewport and the styles it inherits from the <use>.
  const visitUse = (node, path, parentPath, context) => {
    const target = useTarget(node);
    const owner = node.ownerSVGElement;
    const screen = node.getScreenCTM?.();
    if (!target || !owner || !screen) return;
    const useComputed = styleOf(node);
    const x = node.x?.baseVal?.value || 0;
    const y = node.y?.baseVal?.value || 0;
    const isViewport = ["symbol", "svg"].includes(target.localName);
    const ownerBox = owner.viewBox?.baseVal;
    const ownerWidth = ownerBox?.width || owner.width?.baseVal?.value || 0;
    const ownerHeight = ownerBox?.height || owner.height?.baseVal?.value || 0;
    const width = node.width?.baseVal?.value || (isViewport && Number.parseFloat(target.getAttribute("width"))) || ownerWidth;
    const height = node.height?.baseVal?.value || (isViewport && Number.parseFloat(target.getAttribute("height"))) || ownerHeight;
    // A symbol lays out in the use's viewport; anything else in the owner SVG's user space.
    const viewport = isViewport
      ? [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]
      : [[ownerBox?.x || 0, ownerBox?.y || 0], [(ownerBox?.x || 0) + ownerWidth, ownerBox?.y || 0], [ownerBox?.x || 0, (ownerBox?.y || 0) + ownerHeight], [(ownerBox?.x || 0) + ownerWidth, (ownerBox?.y || 0) + ownerHeight]];
    const toScreen = isViewport ? screen : owner.getScreenCTM();
    const corners = viewport.map(([px, py]) => new DOMPoint(px, py).matrixTransform(toScreen));
    const left = Math.min(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const rect = rectIn({x:left, y:top, width:Math.max(...corners.map((point) => point.x)) - left, height:Math.max(...corners.map((point) => point.y)) - top}, context.offset);
    const viewBox = isViewport
      ? target.getAttribute("viewBox") || `0 0 ${width} ${height}`
      : `${ownerBox?.x || 0} ${ownerBox?.y || 0} ${ownerWidth} ${ownerHeight}`;
    const base = isViewport ? [1, 0, 0, 1, 0, 0] : multiplyMatrices(matrixOf(owner.getScreenCTM().inverse().multiply(screen)), [1, 0, 0, 1, x, y]);
    const styles = (element, inherited) => {
      const computed = styleOf(element);
      const parent = element.parentElement ? styleOf(element.parentElement) : null;
      const resolved = Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key,
        INHERITED_SVG_STYLES.includes(key) && parent && computed[key] === parent[key] ? inherited[key] : computed[key]]));
      // `currentColor` computes against the color where the symbol is defined, not where it shows.
      for (const key of ["fill", "stroke"]) {
        const specified = element.getAttribute(key) || element.style?.[key];
        if (/^currentcolor$/i.test(String(specified || "").trim())) resolved[key] = resolved.color;
        else if (!specified && /^currentcolor$/i.test(String(inherited[`${key}Specified`] || ""))) resolved[key] = resolved.color;
      }
      resolved.fillSpecified = /^currentcolor$/i.test(String(element.getAttribute("fill") || element.style?.fill || "").trim()) ? "currentColor" : inherited.fillSpecified;
      resolved.strokeSpecified = /^currentcolor$/i.test(String(element.getAttribute("stroke") || element.style?.stroke || "").trim()) ? "currentColor" : inherited.strokeSpecified;
      return resolved;
    };
    const useStyles = Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, useComputed[key]]));
    nodes.push({path, parentPath, tag:"svg", namespace:SVG_NAMESPACE, role:null, name:node.getAttribute("aria-label") || `use ${node.getAttribute("href") || ""}`.trim(), text:null, textRect:null, textRuns:[],
      rect, styles:{...useStyles, overflow:isViewport ? "hidden" : useStyles.overflow}, attributes:{viewBox, preserveAspectRatio:target.getAttribute("preserveAspectRatio") || undefined}, synthetic:"use"});
    const copy = (element, elementPath, parent, inherited, matrix) => {
      const tagName = element.localName;
      if (SVG_RESOURCES.has(tagName.toLowerCase()) && element !== target) return;
      const elementStyles = styles(element, inherited);
      if (elementStyles.display === "none") return;
      const transform = element === target && isViewport ? matrix : multiplyMatrices(matrix, ownTransform(element));
      const attributes = Object.fromEntries(Array.from(element.attributes).filter((attribute) => CAPTURED_ATTRIBUTES.has(attribute.name)).map((attribute) => [attribute.name, attribute.value]));
      if (element !== target || !isViewport) {
        delete attributes.id;
        if (!isIdentity(transform)) attributes.transformMatrix = transform.map((value) => Number(value.toFixed(6)));
        const {fillSpecified, strokeSpecified, ...ownStyles} = elementStyles;
        nodes.push({path:elementPath, parentPath:parent, tag:tagName.toLowerCase(), namespace:SVG_NAMESPACE, role:null, name:tagName, text:null, textRect:null, textRuns:[], rect, styles:ownStyles, attributes, synthetic:"use"});
      }
      Array.from(element.children).forEach((child, index) => copy(child, `${elementPath}.${index}`, element === target && isViewport ? parent : elementPath, elementStyles, transform));
    };
    if (isViewport) Array.from(target.children).forEach((child, index) => copy(child, `${path}.${index}`, path, styles(target, useStyles), base));
    else copy(target, `${path}.0`, path, useStyles, base);
  };

  const rootCanvas = {left:-view.scrollX, top:-view.scrollY, right:Infinity, bottom:Infinity};
  visit(root, "0", null, {inResources:false, offset:{x:0, y:0}, clip:rootCanvas, canvas:rootCanvas});
  // A gradient referenced from inside the selection may be defined outside it, often in a sprite
  // sheet at the top of the page.
  const capturedIds = new Set(nodes.map((node) => node.attributes.id).filter(Boolean));
  const references = new Set(nodes.flatMap((node) => [node.styles.fill, node.styles.stroke])
    .map((value) => String(value || "").match(/^url\(["']?#([^"')]+)["']?\)$/)?.[1]).filter(Boolean));
  const servers = Array.from(references).filter((id) => !capturedIds.has(id))
    .map((id) => root.getRootNode().getElementById?.(id) || root.ownerDocument.getElementById(id))
    .filter((element) => ["lineargradient", "radialgradient"].includes(element?.localName.toLowerCase()));
  if (servers.length) {
    nodes.push({path:"0.defs", parentPath:"0", tag:"defs", namespace:SVG_NAMESPACE, role:null, name:"defs", text:null, textRect:null, textRuns:[], rect:{x:0, y:0, width:0, height:0}, styles:{}, attributes:{}});
    servers.forEach((server, index) => visit(server, `0.defs.${index}`, "0.defs", {inResources:true, offset:{x:0, y:0}, clip:rootCanvas, canvas:rootCanvas}));
  }
  const imageSizes = await measureBackgroundImages(nodes);
  return {
    format: CAPTURE_FORMAT, version: CAPTURE_VERSION,
    label: options.label
      || nodes.find((node) => node.text)?.text?.slice(0, 96)
      || root.getAttribute("aria-label")
      || root.getAttribute("data-slot")
      || root.tagName.toLowerCase(),
    source: { url: options.url || globalThis.location?.href || null, selector: options.selector || null },
    capturedAt: options.capturedAt || new Date().toISOString(), rootPath: "0", nodes, imageSizes,
  };
}
