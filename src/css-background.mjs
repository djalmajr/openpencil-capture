import { zlibSync } from "fflate";
import { encodeBase64 } from "./base64.mjs";
import { gradientColor } from "./css-color.mjs";
import { clamp, round, splitCssArguments } from "./css-values.mjs";

const TURN = Math.PI * 2;

// Splits on whitespace outside parentheses, so `rgb(1, 2, 3) 10%` is two tokens.
function splitTokens(value) {
  const tokens = [];
  let depth = 0;
  let current = "";
  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function angleInDegrees(token) {
  const match = token?.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return {deg:value, turn:value * 360, rad:value * 180 / Math.PI, grad:value * 0.9}[match[2].toLowerCase()];
}

const normalizeDegrees = (value) => (value % 360 + 360) % 360;

// `calc(100% - 10px)`, `30%`, `12px` or a keyword, as an offset into `range` pixels.
export function resolveLength(token, range) {
  if (token == null || token === "auto") return null;
  const keyword = {left:0, top:0, center:0.5, right:1, bottom:1}[token];
  if (keyword !== undefined) return keyword * range;
  const calc = token.match(/^calc\((.*)\)$/i);
  if (calc) {
    let total = 0;
    for (const [, sign, number, unit] of calc[1].matchAll(/([+-]?)\s*([\d.]+)(%|px)?/g)) {
      const value = Number(number) * (sign === "-" ? -1 : 1);
      total += unit === "%" ? value / 100 * range : value;
    }
    return total;
  }
  const number = Number.parseFloat(token);
  if (!Number.isFinite(number)) return null;
  return token.endsWith("%") ? number / 100 * range : number;
}

// A gradient's interpolation space (`in oklab`, `in oklch longer hue`) changes how it blends, not
// its geometry: it is read apart from the descriptor.
function interpolationOf(tokens) {
  const index = tokens.indexOf("in");
  if (index === -1) return {tokens, space:null};
  const hue = ["shorter", "longer", "increasing", "decreasing"].includes(tokens[index + 2]) ? tokens[index + 2] : null;
  return {tokens:[...tokens.slice(0, index), ...tokens.slice(index + 2 + (hue ? 2 : 0))], space:{name:tokens[index + 1], hue:hue || "shorter"}};
}

const linear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const gamma = (value) => value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055;

function toOklab({r, g, b}) {
  const [lr, lg, lb] = [r, g, b].map((value) => linear(value / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([lightness, a, b]) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((value) => clamp(gamma(value)) * 255);
}

// Each space as a way into its coordinates and back; the last coordinate of a polar space is a hue.
const SPACES = {
  "srgb-linear":{to:({r, g, b}) => [r, g, b].map((value) => linear(value / 255)), from:(values) => values.map((value) => clamp(gamma(value)) * 255)},
  oklab:{to:toOklab, from:fromOklab},
  oklch:{polar:true, to:(color) => {
    const [l, a, b] = toOklab(color);
    return [l, Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
  }, from:([l, c, h]) => fromOklab([l, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)])},
};
// lab and lch blend close to their perceptual relatives; hsl and hwb, close to sRGB.
SPACES.lab = SPACES.oklab;
SPACES.lch = SPACES.oklch;
SPACES.xyz = SPACES["xyz-d65"] = SPACES["xyz-d50"] = SPACES["srgb-linear"];

function hueDelta(from, to, method) {
  let delta = to - from;
  if (method === "shorter") delta = ((delta + 540) % 360) - 180;
  else if (method === "longer") delta = delta > 0 && delta < 180 ? delta - 360 : delta > -180 && delta <= 0 ? delta + 360 : delta;
  else if (method === "increasing") delta = (delta + 360) % 360;
  else if (method === "decreasing") delta = -((360 - delta) % 360);
  return delta;
}

// Premultiplied, like CSS: a transparent end takes the other's coordinates.
function mixIn(space, left, right, amount, hue) {
  const definition = SPACES[space];
  if (!definition) return mix(left, right, amount);
  const a = left.a + (right.a - left.a) * amount;
  const from = definition.to(left);
  const to = definition.to(right);
  const values = from.map((value, index) => {
    if (definition.polar && index === 2) return value + hueDelta(value, to[2], hue) * amount;
    return a > 0 ? (value * left.a + (to[index] * right.a - value * left.a) * amount) / a : value + (to[index] - value) * amount;
  });
  const [r, g, b] = definition.from(values);
  return {r, g, b, a};
}

const SUBDIVISIONS = 8;

// The editor blends stops in sRGB. A gradient that blends in another space, or bends through a
// color hint, gets stops in between, so its sRGB blend follows the right curve.
function curveStops(stops, space) {
  const curved = [];
  stops.forEach((stop, index) => {
    curved.push(stop);
    const next = stops[index + 1];
    if (!next || next.position <= stop.position) return;
    const hint = stop.hint === undefined ? null : clamp((stop.hint - stop.position) / (next.position - stop.position), 1e-4, 1 - 1e-4);
    if (!space && hint === null) return;
    for (let step = 1; step < SUBDIVISIONS; step += 1) {
      const t = step / SUBDIVISIONS;
      const amount = hint === null ? t : t ** (Math.log(0.5) / Math.log(hint));
      curved.push({rgba:space ? mixIn(space.name, stop.rgba, next.rgba, amount, space.hue) : mix(stop.rgba, next.rgba, amount), position:stop.position + (next.position - stop.position) * t});
    }
  });
  return curved;
}

const isLegacyColor = (token) => /^(#|rgba?\(|hsla?\(|hwb\(|[a-z]+$)/i.test(token);

function parseHex(hex) {
  const digits = hex.slice(1);
  const pairs = digits.length <= 4 ? [...digits].map((digit) => digit + digit) : digits.match(/../g);
  const [r, g, b, a = 255] = pairs.map((pair) => Number.parseInt(pair, 16));
  return {r, g, b, a:a / 255};
}

function toHex({r, g, b, a}) {
  const channels = a < 1 ? [r, g, b, a * 255] : [r, g, b];
  return `#${channels.map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// CSS blends gradient colors premultiplied, so a transparent stop never darkens its neighbor.
function mix(left, right, amount) {
  const a = left.a + (right.a - left.a) * amount;
  const channel = (key) => a > 0 ? (left[key] * left.a + (right[key] * right.a - left[key] * left.a) * amount) / a : left[key] + (right[key] - left[key]) * amount;
  return {r:channel("r"), g:channel("g"), b:channel("b"), a};
}

function colorAt(stops, position) {
  if (position <= stops[0].position) return stops[0].rgba;
  for (let index = stops.length - 1; index >= 0; index -= 1) {
    if (stops[index].position > position) continue;
    const next = stops[index + 1];
    if (!next) return stops[index].rgba;
    const span = next.position - stops[index].position;
    return span > 0 ? mix(stops[index].rgba, next.rgba, (position - stops[index].position) / span) : next.rgba;
  }
  return stops.at(-1).rgba;
}

// A stop's position as a fraction of the gradient's ray: `%`, pixels of `length`, or an angle.
function stopPosition(token, length) {
  const angle = angleInDegrees(token);
  if (angle !== null) return angle / 360;
  if (token === "0") return 0;
  const number = Number.parseFloat(token);
  if (!Number.isFinite(number)) return undefined;
  if (token.endsWith("%")) return number / 100;
  if (token.endsWith("px")) return number / Math.max(length, 1e-6);
  return undefined;
}

// Color stops with CSS's fix-up: missing ends at 0 and 1, positions never going back, and the
// ones left out spread evenly between their neighbors. Hints (a lone position) are left out.
export function parseColorStops(args, length, space = null) {
  const stops = [];
  let legacy = true;
  for (const argument of args) {
    const [colorToken, ...positions] = splitTokens(argument);
    if (stopPosition(colorToken, length) !== undefined && positions.length === 0) {
      if (stops.length) stops.at(-1).hintToken = colorToken;
      continue;
    }
    legacy &&= isLegacyColor(colorToken);
    const color = gradientColor(colorToken);
    if (!color) continue;
    const rgba = parseHex(color);
    if (positions.length === 0) stops.push({rgba, position:null});
    for (const token of positions) stops.push({rgba, position:stopPosition(token, length) ?? null});
  }
  if (stops.length < 2) return null;
  if (stops[0].position === null) stops[0].position = 0;
  if (stops.at(-1).position === null) stops.at(-1).position = 1;
  let highest = -Infinity;
  for (const stop of stops) {
    if (stop.position === null) continue;
    stop.position = Math.max(stop.position, highest);
    highest = stop.position;
  }
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index].position !== null) continue;
    const before = index - 1;
    let after = index;
    while (stops[after].position === null) after += 1;
    for (let gap = index; gap < after; gap += 1) {
      stops[gap].position = stops[before].position + (stops[after].position - stops[before].position) * (gap - before) / (after - before);
    }
  }
  for (const stop of stops) {
    if (stop.hintToken !== undefined) stop.hint = stopPosition(stop.hintToken, length);
    delete stop.hintToken;
  }
  // CSS blends legacy colors in sRGB unless told otherwise, and any other color in oklab.
  const blend = space || (legacy ? null : {name:"oklab", hue:"shorter"});
  return curveStops(stops, blend?.name === "srgb" ? null : blend);
}

const MAX_REPEATED_STOPS = 4096;

// The editor's stops live in [0, 1]: a repeating gradient is unrolled over that range, and stops
// beyond it are cut where they cross its ends.
function spanStops(stops, repeating) {
  let unrolled = stops;
  const first = stops[0].position;
  const period = stops.at(-1).position - first;
  if (repeating && period > 1e-6) {
    const fromCycle = Math.floor((0 - stops.at(-1).position) / period);
    const toCycle = Math.ceil((1 - first) / period);
    if ((toCycle - fromCycle + 1) * stops.length <= MAX_REPEATED_STOPS) {
      unrolled = [];
      for (let cycle = fromCycle; cycle <= toCycle; cycle += 1) {
        for (const stop of stops) unrolled.push({...stop, position:stop.position + cycle * period});
      }
    }
  }
  const start = colorAt(unrolled, 0);
  const lastBeforeEnd = unrolled.findIndex((stop) => stop.position >= 1);
  const end = lastBeforeEnd > 0 ? colorAt(unrolled.slice(0, lastBeforeEnd + 1), 1) : colorAt(unrolled, 1);
  const inside = unrolled.filter((stop) => stop.position > 0 && stop.position < 1);
  return [{rgba:start, position:0}, ...inside, {rgba:end, position:1}]
    .map((stop) => ({color:toHex(stop.rgba), position:round(stop.position, 5)}));
}

const SIDES = {left:[-1, 0], right:[1, 0], top:[0, -1], bottom:[0, 1]};

// A side points straight at it; a corner's gradient line is square to the diagonal joining the
// two other corners, so its angle depends on the box's proportions.
export function directionAngle(words, width, height) {
  let x = 0;
  let y = 0;
  for (const word of words) {
    const [dx, dy] = SIDES[word] || [0, 0];
    x += dx;
    y += dy;
  }
  const angle = x && y ? Math.atan2(x * height, -y * width) : Math.atan2(x, -y);
  return normalizeDegrees(angle * 180 / Math.PI);
}

export function linearGradientLength(cssAngle, width, height) {
  const radians = cssAngle * Math.PI / 180;
  return Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
}

function parseLinear(args, box, repeating) {
  let angle = 180;
  const {tokens:descriptor, space} = interpolationOf(splitTokens(args[0]));
  if (descriptor[0] === "to") {
    angle = directionAngle(descriptor.slice(1), box.width, box.height);
    args = args.slice(1);
  } else if (descriptor.length === 1 && angleInDegrees(descriptor[0]) !== null) {
    angle = normalizeDegrees(angleInDegrees(descriptor[0]));
    args = args.slice(1);
  } else if (descriptor.length === 0) {
    args = args.slice(1);
  }
  const stops = parseColorStops(args, linearGradientLength(angle, box.width, box.height), space);
  if (!stops) return null;
  return {type:"gradient", gradientType:"linear", rotation:round(normalizeDegrees(360 - angle)), colors:spanStops(stops, repeating)};
}

const RADIAL_KEYWORDS = new Set(["circle", "ellipse", "closest-side", "closest-corner", "farthest-side", "farthest-corner", "at"]);

function resolvePosition(tokens, box) {
  if (!tokens.length) return {x:box.width / 2, y:box.height / 2};
  let [first, second = "center"] = tokens;
  if (["top", "bottom"].includes(first) || ["left", "right"].includes(second)) [first, second] = [second, first];
  return {x:resolveLength(first, box.width) ?? box.width / 2, y:resolveLength(second, box.height) ?? box.height / 2};
}

function radialRadii(shape, size, center, box) {
  const horizontal = [center.x, box.width - center.x].map(Math.abs);
  const vertical = [center.y, box.height - center.y].map(Math.abs);
  if (size.length) {
    const rx = resolveLength(size[0], box.width);
    const ry = size[1] ? resolveLength(size[1], box.height) : rx;
    return {x:rx, y:ry};
  }
  const keyword = size.keyword || "farthest-corner";
  const pick = keyword.startsWith("closest") ? Math.min : Math.max;
  const sideX = pick(...horizontal);
  const sideY = pick(...vertical);
  if (shape === "circle") {
    const radius = keyword.endsWith("side") ? pick(sideX, sideY) : Math.hypot(sideX, sideY);
    return {x:radius, y:radius};
  }
  // An ellipse through a corner keeps the proportions it would have for the matching sides.
  const scale = keyword.endsWith("corner") ? Math.SQRT2 : 1;
  return {x:sideX * scale, y:sideY * scale};
}

function parseRadial(args, box, repeating) {
  let {tokens, space} = interpolationOf(splitTokens(args[0]));
  const isDescriptor = tokens.length === 0 || RADIAL_KEYWORDS.has(tokens[0]) || /^-?[\d.]+(px|%)?$/.test(tokens[0]) || /^calc\(/.test(tokens[0]);
  let shape = "ellipse";
  const size = [];
  let center = {x:box.width / 2, y:box.height / 2};
  if (isDescriptor) {
    args = args.slice(1);
    const at = tokens.indexOf("at");
    if (at !== -1) {
      center = resolvePosition(tokens.slice(at + 1), box);
      tokens = tokens.slice(0, at);
    }
    for (const token of tokens) {
      if (token === "circle" || token === "ellipse") shape = token;
      else if (RADIAL_KEYWORDS.has(token)) size.keyword = token;
      else size.push(token);
    }
    if (size.length === 1 && !tokens.includes("ellipse")) shape = "circle";
  }
  const radius = radialRadii(shape, size, center, box);
  radius.x = Math.max(radius.x, 0.01);
  radius.y = Math.max(radius.y, 0.01);
  const stops = parseColorStops(args, radius.x, isDescriptor ? space : null);
  if (!stops) return null;
  return {
    type:"gradient", gradientType:"radial",
    center:{x:round(center.x / Math.max(box.width, 1), 5), y:round(center.y / Math.max(box.height, 1), 5)},
    radius:{x:round(radius.x / Math.max(box.width, 1), 5), y:round(radius.y / Math.max(box.height, 1), 5)},
    colors:spanStops(stops, repeating),
  };
}

function parseConic(args, box, repeating) {
  let {tokens, space} = interpolationOf(splitTokens(args[0]));
  let from = 0;
  let center = {x:box.width / 2, y:box.height / 2};
  if (tokens.length === 0 || tokens[0] === "from" || tokens[0] === "at") {
    args = args.slice(1);
    const at = tokens.indexOf("at");
    if (at !== -1) {
      center = resolvePosition(tokens.slice(at + 1), box);
      tokens = tokens.slice(0, at);
    }
    if (tokens[0] === "from") from = angleInDegrees(tokens[1]) ?? 0;
  } else {
    space = null;
  }
  const stops = parseColorStops(args, 1, space);
  if (!stops) return null;
  return {
    type:"gradient", gradientType:"angular", rotation:round(normalizeDegrees(from)),
    center:{x:round(center.x / Math.max(box.width, 1), 5), y:round(center.y / Math.max(box.height, 1), 5)},
    colors:spanStops(stops, repeating),
  };
}

// One CSS gradient image, its geometry in fractions of the `box` it is painted into.
export function parseCssGradient(value, box) {
  const match = value?.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/i);
  if (!match) return null;
  const args = splitCssArguments(match[3]);
  const parse = {linear:parseLinear, radial:parseRadial, conic:parseConic}[match[2].toLowerCase()];
  return parse(args, box, Boolean(match[1]));
}

export function cssImageUrl(value) {
  return value?.match(/^url\((?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\)$/i)?.slice(1).find(Boolean) || null;
}

const layerValue = (list, index) => {
  const values = splitCssArguments(list || "");
  return values[index % values.length];
};

function boxFor(name, styles, width, height) {
  const border = ["Top", "Right", "Bottom", "Left"].map((side) => Number.parseFloat(styles[`border${side}Width`]) || 0);
  const padding = name === "content-box" ? ["Top", "Right", "Bottom", "Left"].map((side) => Number.parseFloat(styles[`padding${side}`]) || 0) : [0, 0, 0, 0];
  if (name === "border-box") return {x:0, y:0, width, height};
  return {
    x:border[3] + padding[3], y:border[0] + padding[0],
    width:Math.max(0, width - border[1] - border[3] - padding[1] - padding[3]),
    height:Math.max(0, height - border[0] - border[2] - padding[0] - padding[2]),
  };
}

function resolveSize(value, area, natural) {
  const ratio = natural && natural.width > 0 && natural.height > 0 ? natural.width / natural.height : null;
  if (value === "cover" || value === "contain") {
    if (!ratio) return {width:area.width, height:area.height};
    const pick = value === "cover" ? Math.max : Math.min;
    const scale = pick(area.width / natural.width, area.height / natural.height);
    return {width:natural.width * scale, height:natural.height * scale};
  }
  const [widthToken = "auto", heightToken = "auto"] = splitTokens(value || "auto");
  let width = resolveLength(widthToken, area.width);
  let height = resolveLength(heightToken, area.height);
  if (width === null && height === null) {
    width = natural ? natural.width : area.width;
    height = natural ? natural.height : area.height;
  } else if (width === null) {
    width = ratio ? height * ratio : area.width;
  } else if (height === null) {
    height = ratio ? width / ratio : area.height;
  }
  return {width, height};
}

function repeatAxes(value) {
  const tokens = splitTokens(value || "repeat");
  if (tokens[0] === "repeat-x") return ["repeat", "no-repeat"];
  if (tokens[0] === "repeat-y") return ["no-repeat", "repeat"];
  return [tokens[0], tokens[1] || tokens[0]];
}

const near = (left, right) => Math.abs(left - right) <= 0.5;
const sameRect = (left, right) => near(left.x, right.x) && near(left.y, right.y) && near(left.width, right.width) && near(left.height, right.height);

/**
 * Where one image lands: `area` positions and sizes it, `clip` bounds what it paints, and each
 * axis repeats or not. Returns the painted `region` in the box and the image's own rect inside it
 * (one tile, when it repeats), or null when nothing of it shows.
 */
export function placeImage({area, clip, size, position, repeat}) {
  const repeats = repeat.map((mode) => mode !== "no-repeat");
  const tile = {...size};
  // `round` stretches the tile to fit a whole number of times.
  if (repeat[0] === "round" && tile.width > 0) tile.width = area.width / Math.max(1, Math.round(area.width / tile.width));
  if (repeat[1] === "round" && tile.height > 0) tile.height = area.height / Math.max(1, Math.round(area.height / tile.height));
  const at = {x:area.x + position.x(area.width - tile.width), y:area.y + position.y(area.height - tile.height)};
  const span = (start, length, clipStart, clipLength, repeated) => repeated
    ? [clipStart, clipStart + clipLength]
    : [Math.max(start, clipStart), Math.min(start + length, clipStart + clipLength)];
  const [left, right] = span(at.x, tile.width, clip.x, clip.width, repeats[0]);
  const [top, bottom] = span(at.y, tile.height, clip.y, clip.height, repeats[1]);
  if (right - left <= 0 || bottom - top <= 0 || tile.width <= 0 || tile.height <= 0) return null;
  const region = {x:left, y:top, width:right - left, height:bottom - top};
  const image = {x:at.x - left, y:at.y - top, width:tile.width, height:tile.height};
  // One tile covering everything it paints repeats nowhere that shows.
  const covers = image.x <= 0.5 && image.y <= 0.5 && image.x + image.width >= region.width - 0.5 && image.y + image.height >= region.height - 0.5;
  return {region, image, repeats:(repeats[0] || repeats[1]) && !covers};
}

function roundRect(rect) {
  return {x:round(rect.x), y:round(rect.y), width:round(rect.width), height:round(rect.height)};
}

/**
 * The CSS background images of a `width` × `height` box, bottom first. Each is a fill and, when
 * it does not paint the whole box, the `region` it paints. `imageSizes` holds the natural size of
 * each url the page measured; without it an image fills the box as `background-size` says.
 */
export function cssBackgroundLayers(styles, width, height, {baseUrl, imageSizes = {}, resolveUrl = (url) => url} = {}) {
  const images = splitCssArguments(styles.backgroundImage || "none");
  const full = {x:0, y:0, width, height};
  const layers = [];
  images.forEach((value, index) => {
    if (!value || value === "none") return;
    const area = boxFor(layerValue(styles.backgroundOrigin, index) || "padding-box", styles, width, height);
    const clipName = layerValue(styles.backgroundClip, index) || "border-box";
    const clip = boxFor(clipName === "text" ? "border-box" : clipName, styles, width, height);
    const sizeValue = layerValue(styles.backgroundSize, index) || "auto";
    const position = {
      x:(range) => resolveLength(layerValue(styles.backgroundPositionX, index) || "0%", range) ?? 0,
      y:(range) => resolveLength(layerValue(styles.backgroundPositionY, index) || "0%", range) ?? 0,
    };
    const repeat = repeatAxes(layerValue(styles.backgroundRepeat, index));
    const rawUrl = cssImageUrl(value);
    if (rawUrl) {
      const url = resolveUrl(rawUrl, baseUrl);
      if (!url) return;
      const natural = imageSizes[rawUrl] || imageSizes[url];
      if (!natural) {
        layers.push({fill:{type:"image", url, mode:sizeValue === "contain" ? "fit" : sizeValue === "cover" ? "fill" : "stretch"}, region:null});
        return;
      }
      const placed = placeImage({area, clip, size:resolveSize(sizeValue, area, natural), position, repeat});
      if (!placed) return;
      const centered = near(placed.image.x + placed.image.width / 2, placed.region.width / 2) && near(placed.image.y + placed.image.height / 2, placed.region.height / 2);
      const fill = sameRect(placed.image, {x:0, y:0, width:placed.region.width, height:placed.region.height})
        ? {type:"image", url, mode:"stretch"}
        : !placed.repeats && sizeValue === "cover" && centered
          ? {type:"image", url, mode:"fill"}
          : {type:"image", url, mode:placed.repeats ? "tile" : "crop", imageRect:roundRect(placed.image)};
      layers.push({fill, region:sameRect(placed.region, full) ? null : roundRect(placed.region)});
      return;
    }
    const tileSize = resolveSize(sizeValue, area, null);
    const placed = placeImage({area, clip, size:tileSize, position, repeat});
    if (!placed) return;
    // A gradient sized to its positioning area repeats only into the border strip, where a border
    // usually covers it: it stays a native gradient. One smaller than its area tiles.
    const offsetX = position.x(area.width - tileSize.width);
    const offsetY = position.y(area.height - tileSize.height);
    const tiled = placed.repeats && (tileSize.width < area.width - 1 || tileSize.height < area.height - 1 || Math.abs(offsetX) > 0.5 || Math.abs(offsetY) > 0.5);
    if (tiled) {
      const gradient = parseCssGradient(value, tileSize);
      const url = gradient && rasterizeGradientTile(gradient, tileSize.width, tileSize.height);
      if (!url) return;
      layers.push({fill:{type:"image", url, mode:"tile", imageRect:roundRect(placed.image), gradient:true}, region:sameRect(placed.region, full) ? null : roundRect(placed.region)});
      return;
    }
    const region = placed.region;
    const fill = parseCssGradient(value, region);
    if (fill) layers.push({fill, region:sameRect(region, full) ? null : roundRect(region)});
  });
  return layers.reverse();
}

const CRC_TABLE = Array.from({length:256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

export function encodePng(width, height, rgba) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) rows.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk("IHDR", header), pngChunk("IDAT", zlibSync(rows)), pngChunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const TILE_SCALE = 2;
const MAX_TILE_SIDE = 1024;
// Every pixel is computed in script, on the page's thread in the extension.
const MAX_TILE_AREA = 512 * 512;

// The editor cannot repeat a gradient, so a tiled one (a dot grid, a checkerboard) becomes a
// repeating image of one tile, drawn at twice its size.
export function rasterizeGradientTile(gradient, width, height) {
  const scale = Math.min(TILE_SCALE, MAX_TILE_SIDE / Math.max(width, height, 1), Math.sqrt(MAX_TILE_AREA / Math.max(width * height, 1)));
  const pixelsWide = Math.max(1, Math.round(width * scale));
  const pixelsHigh = Math.max(1, Math.round(height * scale));
  const stops = gradient.colors.map((stop) => ({rgba:parseHex(stop.color), position:stop.position}));
  const angle = (360 - gradient.rotation) * Math.PI / 180;
  const direction = {x:Math.sin(angle), y:-Math.cos(angle)};
  const length = linearGradientLength(360 - gradient.rotation, width, height);
  const center = gradient.center ? {x:gradient.center.x * width, y:gradient.center.y * height} : {x:width / 2, y:height / 2};
  const rgba = new Uint8Array(pixelsWide * pixelsHigh * 4);
  for (let row = 0; row < pixelsHigh; row += 1) {
    for (let column = 0; column < pixelsWide; column += 1) {
      const x = (column + 0.5) / scale - center.x;
      const y = (row + 0.5) / scale - center.y;
      let position;
      if (gradient.gradientType === "radial") position = Math.hypot(x / (gradient.radius.x * width), y / (gradient.radius.y * height));
      else if (gradient.gradientType === "angular") position = ((Math.atan2(x, -y) - gradient.rotation * Math.PI / 180) % TURN + TURN) % TURN / TURN;
      else position = (x * direction.x + y * direction.y) / length + 0.5;
      const color = colorAt(stops, position);
      rgba.set([color.r, color.g, color.b, color.a * 255].map((value) => Math.round(clamp(value, 0, 255))), (row * pixelsWide + column) * 4);
    }
  }
  return `data:image/png;base64,${encodeBase64(encodePng(pixelsWide, pixelsHigh, rgba))}`;
}
