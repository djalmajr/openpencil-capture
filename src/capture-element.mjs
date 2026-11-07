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
  "clipPath", "maskImage", "maskSize", "maskPosition", "maskRepeat", "maskOrigin", "maskClip", "maskMode", "maskType",
];

const CAPTURED_ATTRIBUTES = new Set([
  "aria-label", "aria-valuenow", "data-slot", "type", "src", "alt", "href",
  "placeholder", "min", "max", "step",
  "d", "fill", "stroke", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
  "cx", "cy", "r", "rx", "ry", "points", "viewBox", "preserveAspectRatio", "text-anchor",
  "id", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "fx", "fy", "clipPathUnits", "maskContentUnits", "clip-rule",
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
    // Coverage goes by Unicode range, so texts in the same blocks share one measurement.
    const blocks = Array.from(new Set(Array.from(probe, (character) => character.codePointAt(0) >> 7))).sort((a, b) => a - b).join(",");
    const key = `${computed.fontStyle} ${computed.fontWeight} ${family} ${blocks}`;
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
const SVG_GRAPHICS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
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

const useHref = (node) => node.getAttribute("href") || node.getAttributeNS("http://www.w3.org/1999/xlink", "href");

// The file an external <use> points into, when the browser draws it: same origin only.
function externalUseFile(node) {
  const href = useHref(node);
  if (!href || href.startsWith("#")) return null;
  try {
    const url = new URL(href, node.ownerDocument.baseURI);
    if (url.origin !== new URL(node.ownerDocument.URL).origin || !url.hash) return null;
    return {file:url.href.slice(0, -url.hash.length), id:decodeURIComponent(url.hash.slice(1))};
  } catch {
    return null;
  }
}

function useTarget(node, externals) {
  const href = useHref(node);
  const external = externalUseFile(node);
  if (external) return externals.get(external.file)?.getElementById(external.id) || null;
  if (!href?.startsWith("#")) return null;
  const id = href.slice(1);
  return node.getRootNode().getElementById?.(id) || node.ownerDocument.getElementById(id);
}

const EXTERNAL_FETCH_TIMEOUT_MS = 3000;

// The files the selection's external <use> elements show, which the browser loaded to draw them,
// parsed; a file that does not come back as SVG is left out.
async function loadUseFiles(root, shadowRootOf) {
  const uses = [];
  const collect = (scope) => {
    for (const element of scope.querySelectorAll("*")) {
      if (element.localName === "use" && element.namespaceURI === SVG_NAMESPACE) uses.push(element);
      const shadow = shadowRootOf(element);
      if (shadow) collect(shadow);
    }
  };
  if (root.localName === "use") uses.push(root);
  collect(root);
  const files = new Set(uses.map((use) => externalUseFile(use)?.file).filter(Boolean));
  const documents = new Map();
  await Promise.all(Array.from(files, async (file) => {
    try {
      const response = await fetch(file, {credentials:"same-origin", cache:"force-cache", signal:AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)});
      if (!response.ok) return;
      const parsed = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
      if (parsed.documentElement?.namespaceURI === SVG_NAMESPACE) documents.set(file, parsed);
    } catch {}
  }));
  return documents;
}

const SVG_PRESENTATION = {
  fill:"fill", fillOpacity:"fill-opacity", fillRule:"fill-rule", stroke:"stroke", strokeWidth:"stroke-width", strokeOpacity:"stroke-opacity",
  strokeDasharray:"stroke-dasharray", strokeDashoffset:"stroke-dashoffset", strokeLinecap:"stroke-linecap", strokeLinejoin:"stroke-linejoin",
  opacity:"opacity", display:"display", visibility:"visibility", color:"color", stopColor:"stop-color", stopOpacity:"stop-opacity",
};
const INHERITED_PRESENTATION = new Set(["fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeDasharray", "strokeDashoffset", "strokeLinecap", "strokeLinejoin", "visibility", "color"]);
const SVG_INITIAL = {fill:"rgb(0, 0, 0)", fillOpacity:"1", fillRule:"nonzero", stroke:"none", strokeWidth:"1px", strokeOpacity:"1", strokeDasharray:"none", strokeDashoffset:"0px", strokeLinecap:"butt", strokeLinejoin:"miter", opacity:"1", display:"inline", visibility:"visible", stopColor:"rgb(0, 0, 0)", stopOpacity:"1"};

/**
 * The styles of an element in a file a <use> shows, which no browser computed: the file's own
 * style rules, its presentation attributes beneath them and its inline style above, then what it
 * inherits. Colors are normalized through a canvas, as a computed style would give them.
 */
function externalStyles(element, inherited, page) {
  const declared = {};
  for (const [key, attribute] of Object.entries(SVG_PRESENTATION)) {
    const value = element.getAttribute(attribute);
    if (value != null) declared[key] = value.trim();
  }
  for (const sheet of element.ownerDocument.querySelectorAll("style")) {
    let rules = [];
    try {
      const parsed = new page.defaultView.CSSStyleSheet();
      parsed.replaceSync(sheet.textContent);
      rules = Array.from(parsed.cssRules);
    } catch {}
    for (const rule of rules) {
      let matches = false;
      try { matches = Boolean(rule.selectorText) && element.matches(rule.selectorText); } catch {}
      if (!matches) continue;
      for (const [key, attribute] of Object.entries(SVG_PRESENTATION)) {
        const value = rule.style.getPropertyValue(attribute);
        if (value) declared[key] = value.trim();
      }
    }
  }
  const inline = element.getAttribute("style");
  if (inline) {
    const holder = page.createElement("span");
    holder.setAttribute("style", inline);
    for (const [key, attribute] of Object.entries(SVG_PRESENTATION)) {
      const value = holder.style.getPropertyValue(attribute);
      if (value) declared[key] = value.trim();
    }
  }
  const context = page.createElement("canvas").getContext("2d");
  const color = (value, fallback) => {
    if (!value || value === "none" || /^url\(/i.test(value)) return value;
    if (/^currentcolor$/i.test(value)) return fallback;
    context.fillStyle = "#010203";
    context.fillStyle = value;
    const normalized = context.fillStyle;
    if (normalized === "#010203" && !/^#010203$/i.test(value)) return value;
    if (normalized.startsWith("#")) {
      const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16));
      return `rgb(${r}, ${g}, ${b})`;
    }
    return normalized;
  };
  const resolved = {};
  for (const key of Object.keys(SVG_PRESENTATION)) {
    const value = declared[key] === "inherit" || (declared[key] === undefined && INHERITED_PRESENTATION.has(key)) ? inherited[key] : declared[key];
    resolved[key] = value ?? SVG_INITIAL[key];
  }
  resolved.color = color(resolved.color, inherited.color) || inherited.color;
  for (const key of ["fill", "stroke", "stopColor"]) resolved[key] = color(resolved[key], resolved.color);
  if (/^[\d.]+$/.test(resolved.strokeWidth)) resolved.strokeWidth = `${resolved.strokeWidth}px`;
  return {...inherited, ...resolved};
}

const measureContexts = new WeakMap();

// A font's metrics as text layout uses them, and the width of `text` set in it.
function fontMetrics(document, computed, text = "") {
  let context = measureContexts.get(document);
  if (!context) {
    context = document.createElement("canvas").getContext("2d");
    measureContexts.set(document, context);
  }
  context.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  context.letterSpacing = computed.letterSpacing === "normal" ? "0px" : computed.letterSpacing;
  const x = context.measureText("x");
  const ascent = x.fontBoundingBoxAscent;
  const descent = x.fontBoundingBoxDescent;
  const lineHeight = Number.parseFloat(computed.lineHeight) || ascent + descent;
  return {ascent, descent, xHeight:x.actualBoundingBoxAscent, lineHeight, width:text ? context.measureText(text).width : 0};
}

const px = (value) => Number.parseFloat(value) || 0;
const edges = (computed, kind) => {
  const suffix = kind === "border" ? "Width" : "";
  const name = (side) => kind === "border" ? `border${side}${suffix}` : `${kind}${side}`;
  return {top:px(computed[name("Top")]), right:px(computed[name("Right")]), bottom:px(computed[name("Bottom")]), left:px(computed[name("Left")])};
};

// An element's content box in the viewport.
function contentBox(node, computed) {
  const rect = node.getBoundingClientRect();
  const border = edges(computed, "border");
  const padding = edges(computed, "padding");
  return {left:rect.left + border.left + padding.left, top:rect.top + border.top + padding.top, right:rect.right - border.right - padding.right, bottom:rect.bottom - border.bottom - padding.bottom};
}

// The boxes a pseudo-element sits between: each in-flow child, text or element, with the first
// and last of its fragments.
function flowItems(node, childNodes, view) {
  const items = [];
  for (const child of childNodes) {
    if (child.nodeType === 3 && child.data.trim()) {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(child);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length) items.push({text:true, parent:child.parentElement, first:rects[0], last:rects.at(-1)});
    } else if (child.nodeType === 1) {
      const style = view.getComputedStyle(child);
      if (style.display === "none" || ["absolute", "fixed"].includes(style.position)) continue;
      if (style.display === "contents") {
        items.push(...flowItems(child, Array.from(child.childNodes), view));
        continue;
      }
      const rects = Array.from(child.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
      if (rects.length) items.push({text:false, style, margin:edges(style, "margin"), border:edges(style, "border"), padding:edges(style, "padding"), first:rects[0], last:rects.at(-1)});
    }
  }
  return items;
}

// The baseline of the line an item sits on: from its text, or from the line's own font.
function itemBaseline(item, view, fallback) {
  if (item?.text) return item.first.top + fontMetrics(item.parent.ownerDocument, view.getComputedStyle(item.parent)).ascent;
  if (item?.style.display === "inline") return item.first.top + item.border.top + item.padding.top + fontMetrics(view.document, item.style).ascent;
  return fallback;
}

/**
 * Where a pseudo-element in the flow is drawn, worked out from what it sits next to, since
 * nothing reports it: a `::before` ends where the first in-flow content starts and an `::after`
 * starts where the last ends, as a first or last child would. Inline ones sit on that line's
 * baseline as `vertical-align` says; block ones stack above or below the content; in a flex
 * container they are items packed with `gap` and aligned on the cross axis. Null for what this
 * cannot place: grid items, right-to-left text, reversed or wrapping flex lines.
 */
function flowPseudoBox(node, pseudo, computed, childNodes) {
  const view = node.ownerDocument.defaultView;
  const parent = view.getComputedStyle(node);
  if (parent.direction === "rtl" || computed.direction === "rtl" || /grid/.test(parent.display)) return null;
  const literal = computed.content.match(/^"((?:[^"\\]|\\.)*)"$/)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
  const margin = edges(computed, "margin");
  const border = edges(computed, "border");
  const padding = edges(computed, "padding");
  const inline = computed.display === "inline";
  const own = fontMetrics(node.ownerDocument, computed, literal);
  const sized = (axis) => {
    const value = px(computed[axis]);
    if (computed.boxSizing === "border-box") return value;
    return axis === "width" ? value + border.left + border.right + padding.left + padding.right : value + border.top + border.bottom + padding.top + padding.bottom;
  };
  const width = inline ? own.width + border.left + border.right + padding.left + padding.right : sized("width");
  const height = inline ? own.ascent + own.descent + border.top + border.bottom + padding.top + padding.bottom : sized("height");
  if (!(width > 0 && height > 0)) return null;
  const content = contentBox(node, parent);
  const items = flowItems(node, childNodes, view);
  const before = pseudo === "::before";
  const neighbor = before ? items[0] : items.at(-1);
  // The text layer holds the content trimmed, as the capture keeps it; collapsed spaces count once.
  const collapses = !/^(pre|pre-wrap|break-spaces)$/.test(computed.whiteSpace);
  const leading = literal.match(/^\s*/)[0];
  const lead = leading ? fontMetrics(node.ownerDocument, computed, collapses ? " " : leading).width : 0;
  const glyphs = fontMetrics(node.ownerDocument, computed, literal.trim()).width;
  const box = (x, y) => ({x, y, width, height, left:x, top:y, right:x + width, bottom:y + height,
    textOffset:{x:border.left + padding.left + lead, y:border.top + padding.top + (inline ? 0 : Math.max(0, (height - border.top - border.bottom - padding.top - padding.bottom - own.lineHeight) / 2) + (own.lineHeight - own.ascent - own.descent) / 2)}, textWidth:glyphs, textHeight:own.ascent + own.descent});
  if (/flex/.test(parent.display)) {
    if (/reverse/.test(parent.flexDirection) || parent.flexWrap !== "nowrap") return null;
    const row = !parent.flexDirection.startsWith("column");
    const gap = px(row ? parent.columnGap : parent.rowGap);
    const align = ["auto", "normal"].includes(computed.alignSelf) ? parent.alignItems : computed.alignSelf;
    const spread = /space-(between|around|evenly)/.test(parent.justifyContent);
    const cross = (start, end, size, marginStart, marginEnd) => /center/.test(align) ? (start + end - size) / 2 + (marginStart - marginEnd) / 2
      : /end/.test(align) ? end - size - marginEnd : start + marginStart;
    if (row) {
      const x = !neighbor || spread
        ? (before ? content.left + margin.left : content.right - width - margin.right)
        : before ? neighbor.first.left - (neighbor.margin?.left || 0) - gap - margin.right - width : neighbor.last.right + (neighbor.margin?.right || 0) + gap + margin.left;
      return box(x, cross(content.top, content.bottom, height, margin.top, margin.bottom));
    }
    const y = !neighbor || spread
      ? (before ? content.top + margin.top : content.bottom - height - margin.bottom)
      : before ? neighbor.first.top - (neighbor.margin?.top || 0) - gap - margin.bottom - height : neighbor.last.bottom + (neighbor.margin?.bottom || 0) + gap + margin.top;
    return box(cross(content.left, content.right, width, margin.left, margin.right), y);
  }
  const lines = fontMetrics(node.ownerDocument, parent);
  if (!inline && !/^inline-/.test(computed.display)) {
    // A block: above the content, or below the last line or box of it.
    if (before || !neighbor) return box(content.left + margin.left, content.top + margin.top);
    const end = neighbor.text ? neighbor.last.bottom + (lines.lineHeight - neighbor.last.height) / 2 : neighbor.last.bottom;
    return box(content.left + margin.left, end + (neighbor.text ? margin.top : Math.max(margin.top, neighbor.margin.bottom)));
  }
  // Inline: beside the first or last content, on its line's baseline.
  const lineStart = (size) => /center/.test(parent.textAlign) ? (content.left + content.right - size) / 2 : /right|end/.test(parent.textAlign) ? content.right - size : content.left;
  const x = !neighbor ? lineStart(width + margin.left + margin.right) + margin.left
    : before ? neighbor.first.left - (neighbor.text ? 0 : neighbor.margin.left) - margin.right - width
    : neighbor.last.right + (neighbor.text ? 0 : neighbor.margin.right) + margin.left;
  const baseline = itemBaseline(neighbor, view, content.top + (lines.lineHeight - lines.ascent - lines.descent) / 2 + lines.ascent);
  const textBaseline = border.top + padding.top + (inline ? 0 : (own.lineHeight - own.ascent - own.descent) / 2) + own.ascent;
  const align = computed.verticalAlign;
  const y = align === "middle" ? baseline - lines.xHeight / 2 - height / 2
    : align === "text-top" ? baseline - lines.ascent + margin.top
    : align === "text-bottom" ? baseline + lines.descent - height - margin.bottom
    : align === "top" ? baseline - lines.ascent - (lines.lineHeight - lines.ascent - lines.descent) / 2 + margin.top
    : align === "bottom" ? baseline + lines.descent + (lines.lineHeight - lines.ascent - lines.descent) / 2 - height - margin.bottom
    : (inline || literal ? baseline - textBaseline : baseline - margin.bottom - height) - (/^-?[\d.]+px$/.test(align) ? px(align) : 0);
  return box(x, y);
}

const MARKER_SYMBOLS = {disc:"• ", circle:"◦ ", square:"▪ ", "disclosure-open":"▾ ", "disclosure-closed":"▸ "};

function romanNumeral(value) {
  if (!(value > 0 && value < 4000)) return String(value);
  return [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]
    .reduce(([text, rest], [amount, letters]) => [text + letters.repeat(Math.floor(rest / amount)), rest % amount], ["", value])[0];
}

function alphabetic(value) {
  let text = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) text = String.fromCharCode(97 + (rest - 1) % 26) + text;
  return text || String(value);
}

// A list item's number: from its list's `start`, counting its list-item siblings, up or down.
function listOrdinal(item) {
  const list = item.parentElement;
  const siblings = list ? Array.from(list.children).filter((child) => child.localName === "li") : [item];
  const reversed = list?.localName === "ol" && list.reversed;
  let value = list?.localName === "ol" && list.hasAttribute("start") ? list.start : reversed ? siblings.length : 1;
  for (const sibling of siblings) {
    if (sibling.hasAttribute("value")) value = Number.parseInt(sibling.getAttribute("value"), 10) || 0;
    if (sibling === item) return value;
    value += reversed ? -1 : 1;
  }
  return value;
}

// The text of a list item's marker, as its `list-style-type` (or the marker's own `content`) writes it.
function markerText(item, markerStyle, itemStyle) {
  const quoted = (value) => value?.match(/^"((?:[^"\\]|\\.)*)"$/)?.[1]?.replace(/\\(.)/g, "$1");
  const own = quoted(markerStyle.content);
  if (own !== undefined) return own;
  const type = itemStyle.listStyleType;
  const written = quoted(type);
  if (written !== undefined) return written;
  if (MARKER_SYMBOLS[type]) return MARKER_SYMBOLS[type];
  const value = listOrdinal(item);
  const numbers = {
    decimal:String(value), "decimal-leading-zero":value >= 0 && value < 10 ? `0${value}` : String(value),
    "lower-alpha":alphabetic(value), "lower-latin":alphabetic(value), "upper-alpha":alphabetic(value).toUpperCase(), "upper-latin":alphabetic(value).toUpperCase(),
    "lower-roman":romanNumeral(value), "upper-roman":romanNumeral(value).toUpperCase(),
  };
  return numbers[type] === undefined ? null : `${numbers[type]}. `;
}

// Properties a referenced element inherits from the <use> that shows it, not from where it sits.
const INHERITED_SVG_STYLES = ["fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeDasharray", "strokeDashoffset", "strokeLinecap", "strokeLinejoin", "color", "visibility"];

// Nothing reports where a pseudo-element is drawn. A positioned one is placed from its containing
// block with the pixels the browser resolves for `left`, `top` and its size, plus the translation
// of its transform; one in the flow, from its neighbors (`flowPseudoBox`).
function pseudoBox(node, computed) {
  if (!["absolute", "fixed"].includes(computed.position)) return null;
  const view = node.ownerDocument.defaultView;
  const number = (value) => Number.parseFloat(value) || 0;
  // The containing block: the nearest box that is positioned (for absolute) or that transforms,
  // filters or contains its descendants (for both); without one, the page or the viewport.
  const fixed = computed.position === "fixed";
  let block = null;
  // The flat tree: a slotted element's parent is its slot, inside the shadow tree.
  for (let element = node; element; element = element.assignedSlot || element.parentElement || element.getRootNode().host || null) {
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

// Where a background or mask image lands depends on its natural size, which only the page knows. The
// browser has already loaded each one, so this mostly reads its cache.
async function measureBackgroundImages(nodes) {
  const urls = new Set();
  for (const node of nodes) {
    for (const match of `${node.styles.backgroundImage || ""} ${node.styles.maskImage || ""}`.matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\)/gi)) {
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
  const useFiles = await loadUseFiles(root, shadowRootOf);
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
    // A clip path's shapes are drawn in the space of what they clip, through their own transform.
    if (isSvg && inResources && SVG_GRAPHICS.has(tag)) {
      const local = ownTransform(node);
      if (!isIdentity(local)) attributes.localTransform = local.map((value) => Number(value.toFixed(6)));
    }
    if (isSvg && !inResources) {
      const transform = svgTransform(node);
      if (transform) attributes.transformMatrix = transform;
      // The shape's box in its own coordinates, where a userSpaceOnUse gradient is placed.
      if (SVG_GRAPHICS.has(tag) && typeof node.getBBox === "function") {
        try {
          const bbox = node.getBBox();
          attributes.bbox = [bbox.x, bbox.y, bbox.width, bbox.height].map((value) => Number(value.toFixed(4)));
        } catch {}
      }
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
    if (drawsPseudo && computed.display === "list-item") visitMarker(node, path, childContext, childNodes, computed);
    if (drawsPseudo) visitPseudo(node, "::before", path, childContext, childNodes);
    childNodes.filter((child) => child.nodeType === 1).forEach((child, index) => visit(child, `${path}.${index}`, path, childContext));
    if (drawsPseudo) visitPseudo(node, "::after", path, childContext, childNodes);
  };

  // A list item's marker: its text, set in the marker's font on the first line's baseline, ending
  // where the line starts when outside, starting there when inside.
  const visitMarker = (node, parentPath, context, childNodes, itemStyle) => {
    const computed = styleOf(node, "::marker");
    if (!computed || computed.content === "none" || itemStyle.listStyleImage !== "none" || itemStyle.direction === "rtl") return;
    const text = markerText(node, computed, itemStyle);
    if (!text?.trim()) return;
    const view = node.ownerDocument.defaultView;
    const metrics = fontMetrics(node.ownerDocument, computed, text);
    const trimmed = text.trim();
    const glyphs = fontMetrics(node.ownerDocument, computed, trimmed);
    const content = contentBox(node, itemStyle);
    const lines = fontMetrics(node.ownerDocument, itemStyle);
    const baseline = itemBaseline(flowItems(node, childNodes, view)[0], view, content.top + (lines.lineHeight - lines.ascent - lines.descent) / 2 + lines.ascent);
    // Chromium offsets a symbol (disc, circle, square, disclosure triangle) by two thirds of its font's ascent and a
    // fixed 7px pad outside, and by one pixel inside; other markers end or start at the line.
    const symbol = Boolean(MARKER_SYMBOLS[itemStyle.listStyleType]) && !/^"/.test(computed.content);
    const inside = itemStyle.listStylePosition === "inside";
    const ascent = Math.round(metrics.ascent);
    const start = symbol
      ? content.left - (inside ? 1 : Math.floor(ascent * 2 / 3) + 8)
      : inside ? content.left : content.left - metrics.width;
    // A symbol is not its glyph: Chromium paints a shape in a box sized from the ascent
    // (RelativeSymbolMarkerRect), a pixel into the marker, on the first line.
    // A disclosure triangle is larger, two thirds of the font size, and stands on the baseline
    // (measured from 12 to 48 pixels).
    const disclosure = /^disclosure/.test(itemStyle.listStyleType);
    const side = disclosure ? px(computed.fontSize) * 2 / 3 : Math.floor((Math.floor(ascent * 2 / 3) + 1) / 2);
    const raw = disclosure ? {x:start + 1, y:baseline - side, width:side, height:side}
      : symbol ? {x:start + 1, y:Math.round(baseline) - ascent + Math.floor(3 * (ascent - Math.floor(ascent * 2 / 3)) / 2), width:side, height:side}
      : {x:start, y:baseline - metrics.ascent, width:glyphs.width, height:metrics.ascent + metrics.descent};
    const box = {left:raw.x + context.offset.x, top:raw.y + context.offset.y, right:raw.x + raw.width + context.offset.x, bottom:raw.y + raw.height + context.offset.y};
    if (!intersects(box, context.clip) || !(raw.width > 0)) return;
    const rect = rectIn(raw, context.offset);
    const shown = isMaskedByCss(computed) ? maskText(trimmed) : trimmed;
    nodes.push({
      path:`${parentPath}.marker`, parentPath, tag:"::marker", namespace:"http://www.w3.org/1999/xhtml", role:null, name:"::marker",
      ...(symbol ? {text:null, textRect:null, textRuns:[]} : {text:shown, textRect:rect, textRuns:[], fontFamily:availableFamily(computed, fontCache, node, trimmed)}),
      rect, styles:Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, computed[key]])),
      attributes:symbol ? {markerSymbol:itemStyle.listStyleType} : {}, synthetic:"pseudo",
    });
  };

  const visitPseudo = (node, pseudo, parentPath, context, childNodes) => {
    const computed = styleOf(node, pseudo);
    if (!computed || computed.content === "none" || computed.content === "normal" || computed.display === "none") return;
    if (computed.visibility !== "visible" || Number.parseFloat(computed.opacity) === 0) return;
    const raw = pseudoBox(node, computed) || flowPseudoBox(node, pseudo, computed, childNodes);
    if (!raw) return;
    const box = {left:raw.left + context.offset.x, top:raw.top + context.offset.y, right:raw.right + context.offset.x, bottom:raw.bottom + context.offset.y};
    if (!intersects(box, computed.position === "fixed" ? context.canvas : context.clip)) return;
    const rect = rectIn(raw, context.offset);
    // Only quoted text: counters, attr() and images have no string the capture can trust.
    const literal = computed.content.match(/^"((?:[^"\\]|\\.)*)"$/)?.[1]?.replace(/\\(.)/g, "$1").trim();
    const quoted = literal && isMaskedByCss(computed) ? maskText(literal) : literal;
    const number = (value) => Number.parseFloat(value) || 0;
    // A box worked out from the flow knows where its text sits; a positioned one centers it.
    const textRect = quoted && raw.textOffset ? {x:rect.x + raw.textOffset.x, y:rect.y + raw.textOffset.y, width:raw.textWidth, height:raw.textHeight} : quoted ? {
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
    const target = useTarget(node, useFiles);
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
      if (element.ownerDocument !== node.ownerDocument) return externalStyles(element, inherited, node.ownerDocument);
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
  // A gradient, clip path or mask referenced from inside the selection may be defined outside it,
  // often in a sprite sheet at the top of the page; a mask's shapes can name gradients in turn.
  const pageUrl = root.ownerDocument.URL.replace(/#.*$/, "");
  const referenceId = (value) => {
    const raw = String(value || "").match(/^url\(["']?([^"')]+)["']?\)$/)?.[1];
    if (!raw) return null;
    if (raw.startsWith("#")) return raw.slice(1);
    try {
      const url = new URL(raw, root.ownerDocument.baseURI);
      return url.hash && url.href.slice(0, -url.hash.length) === pageUrl ? url.hash.slice(1) : null;
    } catch {
      return null;
    }
  };
  const seen = new Set(nodes.map((node) => node.attributes.id).filter(Boolean));
  let pending = nodes;
  for (let pass = 0; pass < 3 && pending.length; pass += 1) {
    const references = new Set(pending.flatMap((node) => [node.styles.fill, node.styles.stroke, node.styles.clipPath, ...String(node.styles.maskImage || "").split(/,(?![^(]*\))/)])
      .map((value) => referenceId(String(value || "").trim())).filter((id) => id && !seen.has(id)));
    const servers = Array.from(references, (id) => root.getRootNode().getElementById?.(id) || root.ownerDocument.getElementById(id))
      .filter((element) => ["lineargradient", "radialgradient", "clippath", "mask"].includes(element?.localName.toLowerCase()));
    references.forEach((id) => seen.add(id));
    const before = nodes.length;
    if (servers.length && !nodes.some((node) => node.path === "0.defs")) nodes.push({path:"0.defs", parentPath:"0", tag:"defs", namespace:SVG_NAMESPACE, role:null, name:"defs", text:null, textRect:null, textRuns:[], rect:{x:0, y:0, width:0, height:0}, styles:{}, attributes:{}});
    const offset = nodes.filter((node) => node.parentPath === "0.defs").length;
    servers.forEach((server, index) => visit(server, `0.defs.${offset + index}`, "0.defs", {inResources:true, offset:{x:0, y:0}, clip:rootCanvas, canvas:rootCanvas}));
    pending = nodes.slice(before);
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
