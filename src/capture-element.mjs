export const CAPTURE_FORMAT = "openpencil-capture-ir";
export const CAPTURE_VERSION = 1;

export const CAPTURED_STYLE_KEYS = [
  "display", "position", "flexDirection", "alignItems", "justifyContent", "gap",
  "backgroundColor", "backgroundImage", "color",
  "backgroundPosition", "backgroundRepeat", "backgroundSize",
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

export function captureElement(root, options = {}) {
  if (typeof Element === "undefined" || !(root instanceof Element)) {
    throw new TypeError("captureElement expects a DOM Element");
  }
  const rootRect = root.getBoundingClientRect();
  const nodes = [];
  const visit = (node, path, parentPath) => {
    const rect = node.getBoundingClientRect();
    const computed = getComputedStyle(node);
    const { text, textRect, textRuns } = directTextSnapshot(node, rootRect, computed);
    const attributes = Object.fromEntries(Array.from(node.attributes)
      .filter((attribute) => CAPTURED_ATTRIBUTES.has(attribute.name))
      .map((attribute) => [attribute.name, attribute.value]));
    if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) {
      // The page shows bullets for a password, and a capture may end up in a shared design file.
      if (node.type === "password") attributes.maskedValue = "•".repeat(node.value.length);
      else if (node.type !== "hidden") attributes.value = node.value;
      attributes.disabled = node.disabled;
      if ("checked" in node) attributes.checked = node.checked;
      if (node.tagName === "SELECT") attributes.selectedLabel = node.selectedOptions[0]?.textContent?.trim() || "";
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
      rect: { x: rect.x - rootRect.x, y: rect.y - rootRect.y, width: rect.width, height: rect.height },
      styles: Object.fromEntries(CAPTURED_STYLE_KEYS.map((key) => [key, computed[key]])),
      attributes,
    });
    Array.from(node.children).forEach((child, index) => visit(child, `${path}.${index}`, path));
  };
  visit(root, "0", null);
  return {
    format: CAPTURE_FORMAT, version: CAPTURE_VERSION,
    label: options.label
      || root.innerText?.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 96)
      || root.getAttribute("aria-label")
      || root.getAttribute("data-slot")
      || root.tagName.toLowerCase(),
    source: { url: options.url || globalThis.location?.href || null, selector: options.selector || null },
    capturedAt: options.capturedAt || new Date().toISOString(), rootPath: "0", nodes,
  };
}
