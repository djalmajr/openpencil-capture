import { gradientTileSource, rasterizeGradientTile, resolveLength, withGradientTile } from "./css-background.mjs";
import { clamp, round, splitCssArguments } from "./css-values.mjs";

// The color functions of `filter`, as Chromium applies them: one after another, in sRGB, each
// clamped, alpha untouched (measured: grayscale(1) of rgb(200, 60, 30) paints 88, 88, 88).
const COLOR_FILTERS = new Set(["grayscale", "sepia", "saturate", "hue-rotate", "invert", "brightness", "contrast"]);

function amountOf(args, fallback = 1) {
  const value = String(args || "").trim();
  if (!value) return fallback;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.endsWith("%") ? number / 100 : number;
}

function degreesOf(args) {
  const match = String(args || "").trim().match(/^(-?[\d.]+)(deg|turn|rad|grad)?$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return {deg:value, turn:value * 360, rad:value * 180 / Math.PI, grad:value * 0.9}[(match[2] || "deg").toLowerCase()];
}

const multiply = (matrix, [r, g, b]) => matrix.map(([x, y, z]) => x * r + y * g + z * b);

function saturationMatrix(s) {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
}

function applyOne({name, args}, rgb) {
  if (name === "grayscale") {
    const s = 1 - clamp(amountOf(args));
    return multiply([
      [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s],
      [0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s],
      [0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s],
    ], rgb);
  }
  if (name === "sepia") {
    const s = 1 - clamp(amountOf(args));
    return multiply([
      [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s],
      [0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s],
      [0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s],
    ], rgb);
  }
  if (name === "saturate") return multiply(saturationMatrix(Math.max(0, amountOf(args))), rgb);
  if (name === "hue-rotate") {
    const radians = degreesOf(args) * Math.PI / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return multiply([
      [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
      [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
      [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ], rgb);
  }
  if (name === "invert") {
    const amount = clamp(amountOf(args));
    return rgb.map((value) => amount + value * (1 - 2 * amount));
  }
  if (name === "brightness") return rgb.map((value) => value * Math.max(0, amountOf(args)));
  if (name === "contrast") {
    const amount = Math.max(0, amountOf(args));
    return rgb.map((value) => (value - 0.5) * amount + 0.5);
  }
  return rgb;
}

export function colorFilterFunctions(functions) {
  return functions.filter(({name}) => COLOR_FILTERS.has(name));
}

// A hex color through the color functions, in order; its alpha stays.
export function filterHex(hex, functions) {
  if (!functions.length || typeof hex !== "string" || !hex.startsWith("#")) return hex;
  const digits = hex.slice(1);
  const pairs = digits.length <= 4 ? [...digits].map((digit) => digit + digit) : digits.match(/../g);
  const [r, g, b, a] = pairs.map((pair) => Number.parseInt(pair, 16));
  let rgb = [r, g, b].map((value) => value / 255);
  for (const fn of functions) rgb = applyOne(fn, rgb).map((value) => clamp(value));
  const channels = [...rgb.map((value) => value * 255), ...(a === undefined ? [] : [a])];
  return `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const filterStops = (colors, functions) => colors.map((stop) => ({...stop, color:filterHex(stop.color, functions)}));

function filterFill(fill, functions, css, skip) {
  if (!fill || (typeof fill === "object" && skip(fill))) return fill;
  if (Array.isArray(fill)) return fill.map((layer) => filterFill(layer, functions, css, skip));
  if (typeof fill === "string") return filterHex(fill, functions);
  if (fill.type === "color") return {...fill, color:filterHex(fill.color, functions)};
  if (fill.type === "gradient") return {...fill, colors:filterStops(fill.colors, functions)};
  if (fill.type !== "image") return fill;
  // A gradient tile is drawn again from filtered stops; an image takes the functions in its pixels.
  const tile = gradientTileSource(fill);
  if (tile) {
    const gradient = {...tile.gradient, colors:filterStops(tile.gradient.colors, functions)};
    return withGradientTile({...fill, url:rasterizeGradientTile(gradient, tile.width, tile.height)}, {...tile, gradient});
  }
  return {...fill, filter:[fill.filter, css].filter(Boolean).join(" ")};
}

/**
 * Applies an element's color filter to everything it paints: every color of the subtree's fills,
 * strokes and shadows, and, for CSS background images, the functions baked into their pixels.
 * Fills and effects `skip` names already took the filter. A mask is left alone: the filter
 * applies to what the mask lets through, not to the mask.
 */
export function filterTree(node, functions, skip = () => false) {
  if (!functions.length || !node || node.isMask) return;
  const css = functions.map(({name, args}) => `${name}(${args})`).join(" ");
  const filterEffect = (effect) => !skip(effect) && effect.color ? {...effect, color:filterHex(effect.color, functions)} : effect;
  if (node.fill) node.fill = filterFill(node.fill, functions, css, skip);
  if (node.stroke) node.stroke = filterHex(node.stroke, functions);
  if (node.effect) node.effect = Array.isArray(node.effect) ? node.effect.map(filterEffect) : filterEffect(node.effect);
  for (const child of node.children || []) filterTree(child, functions, skip);
}

function splitTopLevel(value, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const tokens = (value) => splitTopLevel(String(value || "").trim(), " ").filter(Boolean);

// An empty string is a shape that clips everything away; null, one the editor cannot draw.
function roundedRect(x, y, width, height, radius) {
  if (!(width > 0 && height > 0)) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (!(r > 0)) return `M ${round(x)} ${round(y)} H ${round(x + width)} V ${round(y + height)} H ${round(x)} Z`;
  return `M ${round(x + r)} ${round(y)} H ${round(x + width - r)} A ${round(r)} ${round(r)} 0 0 1 ${round(x + width)} ${round(y + r)} V ${round(y + height - r)} A ${round(r)} ${round(r)} 0 0 1 ${round(x + width - r)} ${round(y + height)} H ${round(x + r)} A ${round(r)} ${round(r)} 0 0 1 ${round(x)} ${round(y + height - r)} V ${round(y + r)} A ${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)} Z`;
}

function ellipsePath(cx, cy, rx, ry) {
  if (!(rx > 0 && ry > 0)) return "";
  return `M ${round(cx - rx)} ${round(cy)} A ${round(rx)} ${round(ry)} 0 1 0 ${round(cx + rx)} ${round(cy)} A ${round(rx)} ${round(ry)} 0 1 0 ${round(cx - rx)} ${round(cy)} Z`;
}

function shapeCenter(words, width, height) {
  const at = words.indexOf("at");
  if (at === -1) return {x:width / 2, y:height / 2};
  let [first = "center", second = "center"] = words.slice(at + 1);
  if (["top", "bottom"].includes(first) || ["left", "right"].includes(second)) [first, second] = [second, first];
  return {x:resolveLength(first, width) ?? width / 2, y:resolveLength(second, height) ?? height / 2};
}

function shapeRadius(token, center, range, sides) {
  if (!token || token === "closest-side") return Math.min(...sides);
  if (token === "farthest-side") return Math.max(...sides);
  return resolveLength(token, range) ?? Math.min(...sides);
}

/**
 * The outline of a `clip-path` basic shape, as path data in the element's border box: an empty
 * string when the shape is empty, null for a value the editor cannot draw (`none`, `url()`).
 */
export function clipPathGeometry(value, width, height) {
  const match = String(value || "").match(/^(inset|circle|ellipse|polygon|path)\((.*)\)/i);
  if (!match) return null;
  const args = match[2].trim();
  const name = match[1].toLowerCase();
  if (name === "path") {
    const d = args.replace(/^(nonzero|evenodd)\s*,\s*/i, "").match(/^["'](.*)["']$/s)?.[1];
    return d || null;
  }
  if (name === "polygon") {
    const points = splitTopLevel(args.replace(/^(nonzero|evenodd)\s*,\s*/i, ""), ",").map((point) => tokens(point));
    if (points.length < 3) return null;
    return `${points.map(([x, y], index) => `${index ? "L" : "M"} ${round(resolveLength(x, width) ?? 0)} ${round(resolveLength(y, height) ?? 0)}`).join(" ")} Z`;
  }
  const words = tokens(args);
  if (name === "inset") {
    const roundAt = words.indexOf("round");
    const offsets = (roundAt === -1 ? words : words.slice(0, roundAt));
    const [top = "0", right = top, bottom = top, left = right] = offsets;
    const t = resolveLength(top, height) ?? 0;
    const r = resolveLength(right, width) ?? 0;
    const b = resolveLength(bottom, height) ?? 0;
    const l = resolveLength(left, width) ?? 0;
    const radius = roundAt === -1 ? 0 : resolveLength(words[roundAt + 1], Math.min(width, height)) ?? 0;
    return roundedRect(l, t, width - l - r, height - t - b, radius);
  }
  const center = shapeCenter(words, width, height);
  const sizeWords = words.indexOf("at") === -1 ? words : words.slice(0, words.indexOf("at"));
  const horizontal = [center.x, width - center.x];
  const vertical = [center.y, height - center.y];
  if (name === "circle") {
    const radius = shapeRadius(sizeWords[0], center, Math.hypot(width, height) / Math.SQRT2, [...horizontal, ...vertical]);
    return ellipsePath(center.x, center.y, radius, radius);
  }
  return ellipsePath(center.x, center.y, shapeRadius(sizeWords[0], center, width, horizontal), shapeRadius(sizeWords[1], center, height, vertical));
}

/**
 * An element's `mask-*` longhands as the `background-*` ones they mirror, so mask layers are
 * placed like background layers. A mask's origin and clip default to the border box.
 */
export function maskLayerStyles(styles) {
  const positions = splitCssArguments(styles.maskPosition || "0% 0%").map((position) => tokens(position));
  const boxes = (value) => splitCssArguments(value || "border-box").map((box) => box === "no-clip" ? "border-box" : box).join(", ");
  return {
    ...styles,
    backgroundImage:styles.maskImage || "none",
    backgroundSize:styles.maskSize || "auto",
    backgroundRepeat:styles.maskRepeat || "repeat",
    backgroundOrigin:boxes(styles.maskOrigin),
    backgroundClip:boxes(styles.maskClip),
    backgroundPositionX:positions.map(([x = "0%"]) => x).join(", "),
    backgroundPositionY:positions.map(([, y = "0%"]) => y).join(", "),
  };
}
