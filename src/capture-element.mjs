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
  "textAlign", "textTransform", "textDecorationLine", "textDecorationColor", "textDecorationThickness", "textUnderlineOffset", "whiteSpace", "textOverflow", "webkitLineClamp", "webkitBoxOrient", "opacity", "overflow", "visibility", "boxShadow",
  "objectFit", "objectPosition", "filter", "mixBlendMode",
  "fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeDasharray", "strokeDashoffset",
  "stopColor", "stopOpacity",
];

const CAPTURED_ATTRIBUTES = new Set([
  "aria-label", "aria-valuenow", "data-slot", "type", "src", "alt", "href",
  "placeholder", "min", "max", "step",
  "d", "fill", "stroke", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
  "cx", "cy", "r", "rx", "ry", "points", "viewBox", "preserveAspectRatio", "text-anchor",
  "id", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
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

function ellipsisWidth(computed) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return Number.parseFloat(computed.fontSize) * 0.75;
  context.font = computed.font || `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  return context.measureText("...").width;
}

function directTextSnapshot(node, rootRect, computed) {
  const nodeRect = node.getBoundingClientRect();
  const textNodes = Array.from(node.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
  const lines = [];
  for (const [sourceIndex, textNode] of textNodes.entries()) {
    for (let index = 0; index < textNode.length; index += 1) {
      const range = document.createRange();
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
  for (const line of lines) {
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
  const runs = visibleLines.flatMap((line, index) => {
    if (!line.entries.length) return [];
    let text = line.entries.map((entry) => entry.character).join("").replace(/\s+/g," ");
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

function isRendered(node) {
  return typeof node.checkVisibility !== "function" || node.checkVisibility({opacityProperty:true});
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
  const view = root.ownerDocument.defaultView;
  // The page's canvas starts at the document origin: anything left of or above it cannot be seen.
  const canvas = {left:-view.scrollX, top:-view.scrollY, right:Infinity, bottom:Infinity};
  const nodes = [];
  const visit = (node, path, parentPath, context) => {
    const tag = node.localName;
    const inResources = context.inResources || (node.namespaceURI === "http://www.w3.org/2000/svg" && SVG_RESOURCES.has(tag.toLowerCase()));
    if (node !== root && !inResources && !isRendered(node)) return;
    const raw = node.getBoundingClientRect();
    const box = {left:raw.left, top:raw.top, right:raw.right, bottom:raw.bottom};
    const computed = getComputedStyle(node);
    const clip = computed.position === "fixed" ? canvas : context.clip;
    // `content-visibility:hidden` renders the element's box and skips everything inside it.
    const shown = !inResources && computed.visibility === "visible" && computed.contentVisibility !== "hidden";
    const masked = isMaskedByCss(computed);
    const snapshot = directTextSnapshot(node, rootRect, computed);
    const visibleRuns = shown ? snapshot.textRuns.filter((run) => intersects({
      left:run.rect.x + rootRect.x, top:run.rect.y + rootRect.y,
      right:run.rect.x + rootRect.x + run.rect.width, bottom:run.rect.y + rootRect.y + run.rect.height,
    }, clip)) : [];
    const visibleSnapshot = visibleRuns.length === snapshot.textRuns.length ? snapshot : textFromRuns(visibleRuns);
    const { text, textRect, textRuns } = masked ? maskSnapshot(visibleSnapshot) : visibleSnapshot;
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
      attributes.effectiveFilter = effectiveFilter(node, root);
      attributes.currentSrc = node.currentSrc || node.src || attributes.src || null;
      attributes.naturalWidth = node.naturalWidth;
      attributes.naturalHeight = node.naturalHeight;
    }
    if (["INPUT", "TEXTAREA"].includes(node.tagName) && attributes.placeholder) {
      const placeholder = getComputedStyle(node, "::placeholder");
      attributes.placeholderColor = placeholder.color;
      attributes.placeholderOpacity = placeholder.opacity;
    }
    nodes.push({
      path, parentPath, tag: node.tagName.toLowerCase(), namespace: node.namespaceURI,
      role: node.getAttribute("role"),
      name: node.getAttribute("data-slot") || node.getAttribute("aria-label") || text || node.tagName.toLowerCase(),
      text, textRect, textRuns,
      rect: { x: raw.x - rootRect.x, y: raw.y - rootRect.y, width: raw.width, height: raw.height },
      styles: Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, computed[key]])),
      attributes,
    });
    const childContext = {inResources, clip:contentClip(computed, box, clip)};
    Array.from(node.children).forEach((child, index) => visit(child, `${path}.${index}`, path, childContext));
  };
  visit(root, "0", null, {inResources:false, clip:canvas});
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
