import { cssBackgroundLayers, cssImageUrl, placeImage, resolveLength } from "./css-background.mjs";
import { colorWithCombinedOpacity, colorWithOpacity, gradientColor, safeColor } from "./css-color.mjs";
import { pathBounds, transformPath } from "./scene-nodes.mjs";
import { clipPathGeometry, colorFilterFunctions, filterHex, filterTree, maskLayerStyles } from "./css-effects.mjs";
import { clamp, px, round, splitCssArguments } from "./css-values.mjs";

export { cssColorToHex } from "./css-color.mjs";

const CORNERS = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"];

// A corner's radius may be `50%` or elliptical (`10px 20%`); the editor's corners are circular, so
// each takes the smaller of its two radii. CSS then shrinks all of them by the same factor when
// two neighbors would overlap along a side.
function cornerRadius(node) {
  const {width, height} = node.rect;
  const radii = CORNERS.map((key) => {
    const [horizontal, vertical = horizontal] = String(node.styles[key] || "0px").trim().split(/\s+/);
    return Math.max(0, Math.min(resolveLength(horizontal, width) ?? 0, resolveLength(vertical, height) ?? 0));
  });
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const scale = Math.min(1, ...[[width, topLeft + topRight], [height, topRight + bottomRight], [width, bottomRight + bottomLeft], [height, bottomLeft + topLeft]]
    .filter(([, sum]) => sum > 0).map(([side, sum]) => side / sum));
  const values = radii.map((radius) => round(radius * scale));
  return values.every((value) => value === values[0]) ? values[0] : values;
}

// Each corner's [horizontal, vertical] radii, scaled as CSS does when neighbors overlap along a
// side, or null when every corner is circular and the editor's own corners draw them.
function ellipticalCorners(node) {
  const {width, height} = node.rect;
  const radii = CORNERS.map((key) => {
    const [horizontal, vertical = horizontal] = String(node.styles[key] || "0px").trim().split(/\s+/);
    const x = Math.max(0, resolveLength(horizontal, width) ?? 0);
    const y = Math.max(0, resolveLength(vertical, height) ?? 0);
    return x > 0 && y > 0 ? [x, y] : [0, 0];
  });
  const [tl, tr, br, bl] = radii;
  const scale = Math.min(1, ...[[width, tl[0] + tr[0]], [height, tr[1] + br[1]], [width, br[0] + bl[0]], [height, bl[1] + tl[1]]]
    .filter(([, sum]) => sum > 0).map(([side, sum]) => side / sum));
  const scaled = radii.map(([x, y]) => [x * scale, y * scale]);
  return scaled.some(([x, y]) => Math.abs(x - y) > 0.5) ? scaled : null;
}

// A box with elliptical corners as path data; `radii` go top left, top right, bottom right, bottom left.
function roundedBoxPath({x, y, width, height}, radii) {
  const [tl, tr, br, bl] = radii.map(([rx, ry]) => rx > 0 && ry > 0 ? [rx, ry] : [0, 0]);
  const arc = ([rx, ry], ex, ey) => rx > 0 ? `A ${round(rx)} ${round(ry)} 0 0 1 ${round(ex)} ${round(ey)}` : `L ${round(ex)} ${round(ey)}`;
  return [
    `M ${round(x + tl[0])} ${round(y)}`, `H ${round(x + width - tr[0])}`, arc(tr, x + width, y + tr[1]),
    `V ${round(y + height - br[1])}`, arc(br, x + width - br[0], y + height),
    `H ${round(x + bl[0])}`, arc(bl, x, y + height - bl[1]),
    `V ${round(y + tl[1])}`, arc(tl, x + tl[0], y), "Z",
  ].join(" ");
}

/**
 * A box whose corners the editor cannot draw: its background and shadows go on a vector of the
 * exact outline, and its border on a ring between that outline and the padding box's, whose
 * corners shrink by the border's widths as CSS draws them. A dashed or dotted border is a stroke
 * along the middle of the ring.
 */
function ellipticalBoxLayers(node, radii, {fills, border, shadows}) {
  const width = round(node.rect.width);
  const height = round(node.rect.height);
  const name = semanticLayerName(node);
  const outer = roundedBoxPath({x:0, y:0, width, height}, radii);
  const base = {type:"path", layoutPosition:"absolute", x:0, y:0, width, height, viewBox:[0, 0, width, height]};
  const layers = [{...base, name:`${name} · Background`, geometry:outer, fill:fills.length ? (fills.length === 1 ? fills[0] : fills) : "#00000000",
    ...(shadows.length ? {effect:shadows.length === 1 ? shadows[0] : shadows} : {})}];
  if (!border.stroke) return layers;
  const widths = typeof border.strokeWidth === "object" ? border.strokeWidth : {top:border.strokeWidth, right:border.strokeWidth, bottom:border.strokeWidth, left:border.strokeWidth};
  const inset = (amount) => ({x:amount.left, y:amount.top, width:width - amount.left - amount.right, height:height - amount.top - amount.bottom});
  const shrink = (amount) => radii.map(([rx, ry], index) => [
    Math.max(0, rx - (index === 0 || index === 3 ? amount.left : amount.right)),
    Math.max(0, ry - (index < 2 ? amount.top : amount.bottom)),
  ]);
  if (border.dashPattern) {
    const half = Object.fromEntries(Object.entries(widths).map(([side, value]) => [side, value / 2]));
    const strokeWidth = Math.max(...Object.values(widths));
    const style = ["Top", "Right", "Bottom", "Left"].map((side) => node.styles[`border${side}Style`]).find((value) => value === "dashed" || value === "dotted");
    layers.push({...base, name:`${name} · Border`, geometry:roundedBoxPath(inset(half), shrink(half)), fill:"#00000000",
      stroke:border.stroke, strokeWidth, ...loopDashes(style, strokeWidth, outlinePerimeter(inset(half), measuredCorners(shrink(half))))});
  } else {
    layers.push({...base, name:`${name} · Border`, geometry:`${outer} ${roundedBoxPath(inset(widths), shrink(widths))}`, fillRule:"evenodd", fill:border.stroke});
  }
  return layers;
}

function parseGradientStop(value) {
  const match = value.match(/^(.*?)(?:\s+(-?[\d.]+)(px|%))?$/);
  const color = gradientColor(match?.[1]?.trim());
  if (!color) return null;
  return { color, position:match?.[2] == null ? null : Number(match[2]), unit:match?.[3] || null };
}

function assetUrl(value, baseUrl) {
  if (!value) return null;
  if (value.startsWith("data:") || value.startsWith("blob:")) return value;
  try {
    const url = new URL(value,baseUrl || undefined);
    return ["http:","https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function backgroundLayers(node, capture) {
  return cssBackgroundLayers(node.styles, node.rect.width, node.rect.height, {
    baseUrl:capture?.source?.url, imageSizes:capture?.imageSizes, resolveUrl:assetUrl,
  });
}

// The id a `url()` names when it points into the page itself (`url(#m)`, or the page's own
// address with a fragment), or null for any other value.
function documentReference(value, pageUrl) {
  const raw = String(value || "").match(/^url\(["']?([^"')]+)["']?\)$/)?.[1];
  if (!raw) return null;
  if (raw.startsWith("#")) return raw.slice(1) || null;
  try {
    const target = new URL(raw, pageUrl || undefined);
    const page = new URL(pageUrl || target.href);
    return target.hash && target.href.slice(0, -target.hash.length) === page.href.replace(/#.*$/, "") ? target.hash.slice(1) : null;
  } catch {
    return null;
  }
}

function maskedGroup(layer, mask, inPlace = false) {
  if (inPlace) return {type:"group", name:layer.name, layoutPosition:"absolute", x:0, y:0, children:[mask, layer]};
  return {type:"group", name:layer.name, layoutPosition:"absolute", x:layer.x, y:layer.y, children:[mask, {...layer, x:0, y:0}]};
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

const multiply = ([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) => [
  a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
];

// The shapes of a <clipPath> or <mask>, each as an outline in the space `matrix` maps them into;
// in `objectBoundingBox` units the box is the unit square.
function resourceOutlines(resource, unitsAttribute, matrix, box) {
  const boxUnits = resource.node.attributes[unitsAttribute] === "objectBoundingBox";
  if (boxUnits && !(box.width > 0 && box.height > 0)) return null;
  const units = boxUnits ? [box.width, 0, 0, box.height, box.x, box.y] : IDENTITY;
  return resource.shapes.map((shape) => {
    const geometry = primitivePath(shape, boxUnits ? [0, 0, 1, 1] : [0, 0, box.width, box.height]);
    if (!geometry) return null;
    const rule = shape.attributes["clip-rule"] || shape.styles.fillRule;
    return {shape, geometry:transformPath(geometry, multiply(multiply(matrix, units), shape.attributes.localTransform || IDENTITY), rule)};
  }).filter(Boolean);
}

/**
 * `mask` and `clip-path`, as the editor's masks: the layer goes into a group whose first child
 * masks it. A clip shape or <clipPath> becomes a vector; mask-image layers an alpha (or
 * luminance) frame placed like backgrounds, and a <mask> a luminance frame of its shapes. Inside
 * an SVG they are drawn in the element's user space, through the SVG's viewBox. Returns null when
 * the clip leaves nothing.
 */
function withCssMasks(node, layer, capture, context) {
  if (!layer) return layer;
  const pageUrl = capture?.source?.url;
  const inSvg = node.namespace === "http://www.w3.org/2000/svg" && node.tag !== "svg";
  const svg = inSvg ? context.svgOf(node) : null;
  if (inSvg && !svg) return layer;
  const width = round(inSvg ? svg.rect.width : node.rect.width);
  const height = round(inSvg ? svg.rect.height : node.rect.height);
  const [bx = 0, by = 0, bw = 0, bh = 0] = node.attributes.bbox || [];
  const space = inSvg
    ? {matrix:node.attributes.transformMatrix || IDENTITY, box:{x:bx, y:by, width:bw, height:bh}, viewBox:(svg.attributes.viewBox || `0 0 ${svg.rect.width} ${svg.rect.height}`).split(/[\s,]+/).map(Number)}
    : {matrix:IDENTITY, box:{x:0, y:0, width, height}, viewBox:[0, 0, width, height]};
  const frame = {layoutPosition:"absolute", x:0, y:0, width, height};
  const vector = (geometry) => ({type:"path", ...frame, geometry, viewBox:space.viewBox, ...(svg?.attributes.preserveAspectRatio === "none" ? {stretchViewBox:true} : {})});
  const clipId = documentReference(node.styles.clipPath, pageUrl);
  const clipOutlines = clipId && context.clipPaths.has(clipId) ? resourceOutlines(context.clipPaths.get(clipId), "clipPathUnits", space.matrix, space.box) : null;
  const geometry = clipOutlines ? clipOutlines.map((outline) => outline.geometry).join(" ") : inSvg ? null : clipPathGeometry(node.styles.clipPath, width, height);
  if (geometry === "") return null;
  let result = layer;
  const images = splitCssArguments(node.styles.maskImage || "none").filter((value) => value && value !== "none");
  const references = images.map((value) => documentReference(value, pageUrl));
  const element = references.length === 1 && references[0] ? context.masks.get(references[0]) : null;
  const outlines = element ? resourceOutlines(element, "maskContentUnits", space.matrix, space.box) : null;
  if (outlines) {
    result = maskedGroup(result, {
      type:"frame", name:`${semanticLayerName(node)} · Mask`, layout:"none", ...frame, isMask:true,
      maskType:element.node.styles.maskType === "alpha" ? "ALPHA" : "LUMINANCE",
      children:outlines.map(({shape, geometry: outline}) => ({...vector(outline), name:semanticLayerName(shape), ...graphicPaint(shape, 1, context.paintServers), stroke:undefined})),
    }, inSvg);
  } else if (!inSvg && images.length && !references.some(Boolean)) {
    const layers = cssBackgroundLayers(maskLayerStyles(node.styles), width, height, {baseUrl:pageUrl, imageSizes:capture?.imageSizes, resolveUrl:assetUrl});
    result = maskedGroup(result, {
      type:"frame", name:`${semanticLayerName(node)} · Mask`, layout:"none", ...frame,
      isMask:true, maskType:node.styles.maskMode === "luminance" ? "LUMINANCE" : "ALPHA",
      children:layers.map((mask, index) => ({type:"rectangle", name:`${semanticLayerName(node)} · Mask layer ${index + 1}`, layoutPosition:"absolute", ...(mask.region || {x:0, y:0, width, height}), fill:mask.fill})),
    });
  }
  if (geometry) {
    result = maskedGroup(result, {...vector(geometry), name:`${semanticLayerName(node)} · Clip path`, fill:"#000000", isMask:true, maskType:"VECTOR"}, inSvg);
    // A shape reaching past the box would widen the group past the element; what it would show
    // there is only overflowing content, which the box then clips.
    const bounds = inSvg ? null : pathBounds(geometry);
    if (bounds && (bounds.x < -0.5 || bounds.y < -0.5 || bounds.x + bounds.width > width + 0.5 || bounds.y + bounds.height > height + 0.5)) {
      result = {type:"frame", name:result.name, layout:"none", layoutPosition:"absolute", x:result.x, y:result.y, width, height, clip:true, children:[{...result, x:0, y:0}]};
    }
  }
  return result;
}

// The topmost background image or gradient as a fill.
export function cssBackgroundToFill(node, options = {}) {
  return backgroundLayers(node, {source:{url:options.baseUrl}, imageSizes:options.imageSizes}).at(-1)?.fill ?? null;
}

function repeatingLinearPattern(node) {
  const value = node.styles.backgroundImage;
  const match = value?.match(/^repeating-linear-gradient\((.*)\)$/i);
  if (!match) return null;
  const args = splitCssArguments(match[1]);
  let cssAngle = 180;
  if (/^-?[\d.]+deg$/i.test(args[0])) cssAngle = Number.parseFloat(args.shift());
  const stops = args.map(parseGradientStop).filter(Boolean);
  const pixelStops = stops.filter((stop) => stop.unit === "px" && Number.isFinite(stop.position));
  const period = Math.max(...pixelStops.map((stop) => stop.position));
  if (!(period > 0)) return null;
  const bands = [];
  for (let index = 0; index < pixelStops.length - 1; index += 1) {
    const start = pixelStops[index];
    const end = pixelStops[index + 1];
    if (start.color === end.color && start.color !== "#00000000" && end.position > start.position) {
      bands.push({color:start.color,start:start.position,end:end.position});
    }
  }
  if (!bands.length) return null;
  const width = round(node.rect.width);
  const height = round(node.rect.height);
  const radians = cssAngle * Math.PI / 180;
  const direction = {x:Math.cos(radians),y:Math.sin(radians)};
  const gradientAxis = {x:Math.sin(radians),y:-Math.cos(radians)};
  const lineLength = Math.abs(gradientAxis.x) * width + Math.abs(gradientAxis.y) * height;
  const length = Math.hypot(width,height) * 1.5;
  const center = {x:width / 2,y:height / 2};
  const children = [];
  for (const band of bands) {
    // CSS measures stops from the start of the gradient line, half its length before the center.
    for (let stop = (band.start + band.end) / 2; stop <= lineLength + period; stop += period) {
      const distance = stop - lineLength / 2;
      const cx = center.x + gradientAxis.x * distance;
      const cy = center.y + gradientAxis.y * distance;
      children.push({
        type:"path",name:"Diagonal stripe",layoutPosition:"absolute",x:0,y:0,width,height,
        geometry:`M ${round(cx-direction.x*length)} ${round(cy-direction.y*length)} L ${round(cx+direction.x*length)} ${round(cy+direction.y*length)}`,
        viewBox:[0,0,width,height],fill:"#00000000",stroke:band.color,strokeWidth:round(band.end-band.start),strokeLinecap:"butt",
      });
    }
  }
  return {type:"frame",name:`${semanticLayerName(node)} · Background image`,layout:"none",layoutPosition:"absolute",x:0,y:0,width,height,clip:true,children};
}

function transformedText(node, value = node.text) {
  if (node.styles.textTransform === "uppercase") return value.toUpperCase();
  if (node.styles.textTransform === "lowercase") return value.toLowerCase();
  if (node.styles.textTransform === "capitalize") return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  return value;
}

const GENERIC_FONT_FAMILIES = new Set(["serif","sans-serif","monospace","cursive","fantasy","system-ui","ui-serif","ui-sans-serif","ui-monospace","ui-rounded","-apple-system","BlinkMacSystemFont"]);

// The family the page drew with, when the capture measured it; older captures name only the list.
function fontFamily(value, resolved) {
  const family = resolved || value?.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") || "Noto Sans";
  return family === "Geist Variable" || GENERIC_FONT_FAMILIES.has(family) ? "Inter" : family;
}

function isCssShown(node) {
  return px(node.styles.opacity, 1) > 0 && node.styles.display !== "none" && node.styles.visibility !== "hidden";
}

function isVisible(node) {
  return node.rect.width > 0 && node.rect.height > 0 && isCssShown(node);
}

function isVisibleSvgContainer(node) {
  return node.namespace === "http://www.w3.org/2000/svg"
    && ["svg", "g"].includes(node.tag)
    && isCssShown(node);
}

function isVisibleSvgGraphic(node) {
  return node.namespace === "http://www.w3.org/2000/svg"
    && ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(node.tag)
    && isCssShown(node)
    && (node.rect.width > 0 || node.rect.height > 0);
}

function isVisuallyHiddenControl(node) {
  return ["input", "select", "textarea"].includes(node.tag)
    && node.rect.width <= 1
    && node.rect.height <= 1;
}

function isVisuallyHiddenElement(node) {
  return node.rect.width <= 1
    && node.rect.height <= 1
    && ["absolute", "fixed"].includes(node.styles.position)
    && node.styles.overflow === "hidden";
}

function inferTitle(capture, rootSource) {
  const declared = capture.label?.replace(/\s+/g, " ").trim();
  if (declared && declared.length <= 80) return declared;
  const candidate = capture.nodes.find((node) => node.path !== capture.rootPath && node.text && isVisible(node) && node.text.length <= 80 && node.rect.y <= Math.min(120, rootSource.rect.height / 2));
  return (candidate?.text || declared || rootSource.name || "Element").replace(/\s+/g, " ").trim().slice(0, 80);
}

function parseCssShadows(value) {
  if (!value || value === "none") return [];
  return splitCssArguments(value).flatMap((shadow) => {
    const colorMatch = shadow.match(/((?:rgba?|oklch|oklab|lch|lab|color)\([^)]*\)|#[0-9a-f]{3,8})/i);
    const color = safeColor(colorMatch?.[1]);
    if (!color) return [];
    const rest = shadow.replace(colorMatch[0], "");
    const numbers = Array.from(rest.matchAll(/(-?[\d.]+)px/g), (item) => Number(item[1]));
    const offset = {x:numbers[0] || 0,y:numbers[1] || 0};
    const blur = Math.max(0,numbers[2] || 0);
    const spread = numbers[3] || 0;
    // CSS frameworks frequently reset controls with opaque zero-geometry
    // shadows, which would otherwise become visible but meaningless layers.
    if (offset.x === 0 && offset.y === 0 && blur === 0 && spread === 0) return [];
    return [{ type:"shadow", shadowType:shadow.includes("inset") ? "inner" : "outer", offset, blur, spread, color }];
  });
}

function shadowRingBorder(shadows) {
  const ring = shadows.find((shadow) => shadow.offset.x === 0 && shadow.offset.y === 0 && shadow.blur === 0 && shadow.spread > 0);
  return ring ? {stroke:ring.color,strokeWidth:ring.spread,strokeAlignment:"inner"} : {};
}

// A gradient in `userSpaceOnUse` is placed in the SVG's coordinates; the fill's geometry is in
// fractions of the shape's box, so its center and radius are measured against that box.
function resolvePaintServer(server, box) {
  if (!server?.userSpace || !box || !(box.width > 0 && box.height > 0)) return server;
  if (server.gradientType !== "radial") return server;
  const {cx, cy, r} = server.userSpace;
  return {...server, center:{x:round((cx - box.x) / box.width, 5), y:round((cy - box.y) / box.height, 5)}, radius:{x:round(r / box.width, 5), y:round(r / box.height, 5)}};
}

function graphicPaint(node, strokeScale = 1, paintServers = new Map(), userBox = null) {
  const paintReference = node.styles.fill?.match(/^url\(["']?#([^"')]+)["']?\)$/i)?.[1];
  const referencedFill = paintReference ? resolvePaintServer(paintServers.get(paintReference), userBox) : null;
  const fill = referencedFill
    ? {...referencedFill,colors:referencedFill.colors.map((stop) => ({...stop,color:colorWithCombinedOpacity(stop.color,node.styles.fillOpacity)}))}
    : colorWithOpacity(safeColor(node.styles.fill), node.styles.fillOpacity);
  const stroke = colorWithOpacity(safeColor(node.styles.stroke), node.styles.strokeOpacity);
  return {
    fill:fill || "#00000000",
    ...(stroke ? {
      stroke, strokeWidth:round(px(node.styles.strokeWidth, 1) * strokeScale),
      strokeLinecap:node.styles.strokeLinecap || "round", strokeLinejoin:node.styles.strokeLinejoin || "round",
      ...svgDashes(node.styles.strokeDasharray, strokeScale),
    } : {}),
    ...(node.styles.fillRule === "evenodd" ? { fillRule:"evenodd" } : {}),
    ...(px(node.styles.opacity, 1) < 1 ? { opacity:round(px(node.styles.opacity, 1)) } : {}),
  };
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 56);
}

function titleCase(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Element";
}

export function semanticLayerName(node) {
  const tag = node.tag || "element";
  if (tag === "::before" || tag === "::after") return `${titleCase(tag.slice(2))} · Decoration`;
  if (tag === "img") return `Image · ${cleanLabel(node.attributes.alt || node.name || "Asset")}`;
  if (tag === "canvas") return "Canvas · Snapshot";
  const meaningful = cleanLabel(node.name);
  if (meaningful && meaningful.toLowerCase() !== tag && meaningful.length <= 48) return `${titleCase(tag)} · ${meaningful}`;
  if (node.role) return `${titleCase(node.role)} · ${titleCase(tag)}`;
  return titleCase(tag);
}

function relativeRect(node, parent) {
  return {
    x:round(node.rect.x - (parent?.rect.x || 0)),
    y:round(node.rect.y - (parent?.rect.y || 0)),
    width:round(node.rect.width),
    height:round(node.rect.height),
  };
}

function borderProperties(styles) {
  const sides = ["Top", "Right", "Bottom", "Left"];
  const widths = Object.fromEntries(sides.map((side) => [side.toLowerCase(), round(px(styles[`border${side}Width`]))]));
  const visible = sides.find((side) => widths[side.toLowerCase()] > 0 && !["none", "hidden"].includes(styles[`border${side}Style`]) && safeColor(styles[`border${side}Color`]));
  if (!visible) return {};
  const width = widths[visible.toLowerCase()];
  return {
    stroke:safeColor(styles[`border${visible}Color`]),
    strokeWidth:widths.top === widths.right && widths.top === widths.bottom && widths.top === widths.left ? widths.top : widths,
    strokeAlignment:"inner",
    ...borderDashes(styles[`border${visible}Style`], width),
  };
}

// Chromium's dashes, measured: a thin border dashes three widths on and two off, a thicker one
// two on and one off; dots are squares one width apart.
function borderDashes(style, width) {
  if (style === "dashed") return {dashPattern:width < 3 ? [width * 3, width * 2] : [width * 2, width]};
  if (style === "dotted") return {dashPattern:[width, width]};
  return {};
}

// How Chromium lays dashes along one side, measured: the side runs corner to corner, starts and
// ends on a dash, and stretches or shrinks its gaps to fit a whole number of dashes, taking the
// count whose gap is closest to the nominal one. Null when the side is too short to dash.
function sideDashes(length, dash, gap) {
  if (!(length > dash + gap)) return null;
  const gapFor = (count) => (length - count * dash) / (count - 1);
  const fewer = Math.max(2, Math.floor((length + gap) / (dash + gap)));
  const counts = [fewer, fewer + 1].filter((count) => gapFor(count) >= 0);
  const count = counts.reduce((best, count) => Math.abs(gapFor(count) - gap) <= Math.abs(gapFor(best) - gap) ? count : best);
  return {count, gap:gapFor(count)};
}

// A rounded border dashes as one loop along the middle of the border, from where the top side
// leaves its left corner, clockwise; its gaps fit a whole number of dashes around, the count
// whose gap is closest to the nominal one, as Chromium draws it. Chromium measures that loop with
// its corners half a pixel wider than it draws them (measured on 2 to 6 pixel borders), so
// `perimeter` is that length and the last dash runs slightly into the first.
function loopDashes(style, width, perimeter) {
  const roundDots = style === "dotted" && width >= 3;
  const [dash, gap] = style === "dotted" ? [width, width] : width < 3 ? [width * 3, width * 2] : [width * 2, width];
  const gapFor = (count) => (perimeter - count * dash) / count;
  const fewer = Math.max(1, Math.floor(perimeter / (dash + gap)));
  const counts = [fewer, fewer + 1].filter((count) => gapFor(count) >= 0);
  if (!counts.length) return {};
  const count = counts.reduce((best, count) => Math.abs(gapFor(count) - gap) < Math.abs(gapFor(best) - gap) ? count : best);
  return roundDots
    ? {strokeLinecap:"round", dashPattern:[0, round(perimeter / count, 4)]}
    : {strokeLinecap:"butt", dashPattern:[dash, round(gapFor(count), 4)]};
}

const measuredCorners = (radii) => radii.map(([rx, ry]) => rx > 0 && ry > 0 ? [rx + 0.5, ry + 0.5] : [0, 0]);

// The length around a box with elliptical corners (Ramanujan's approximation for each quarter).
function outlinePerimeter({width, height}, radii) {
  const [tl, tr, br, bl] = radii;
  const quarter = ([a, b]) => a > 0 && b > 0 ? Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))) / 4 : 0;
  return width - tl[0] - tr[0] + width - bl[0] - br[0] + height - tr[1] - br[1] + height - tl[1] - bl[1] + radii.reduce((sum, corner) => sum + quarter(corner), 0);
}

/**
 * A dashed or dotted border with square corners, one line per side, so each side's dashes start
 * and end at its corners as Chromium draws them: the editor would start one dash pattern at a
 * corner and run it around. Dots of three pixels and more are round, thinner ones square.
 */
function borderSideLines(node, fallbackColor) {
  const width = round(node.rect.width);
  const height = round(node.rect.height);
  const sides = {
    Top:(w) => [`M 0 ${round(w / 2)} H ${width}`, width, (inset) => `M ${round(inset)} ${round(w / 2)} H ${round(width - inset)}`],
    Right:(w) => [`M ${round(width - w / 2)} 0 V ${height}`, height, (inset) => `M ${round(width - w / 2)} ${round(inset)} V ${round(height - inset)}`],
    Bottom:(w) => [`M 0 ${round(height - w / 2)} H ${width}`, width, (inset) => `M ${round(inset)} ${round(height - w / 2)} H ${round(width - inset)}`],
    Left:(w) => [`M ${round(w / 2)} 0 V ${height}`, height, (inset) => `M ${round(w / 2)} ${round(inset)} V ${round(height - inset)}`],
  };
  return Object.entries(sides).flatMap(([side, geometryFor]) => {
    const w = round(px(node.styles[`border${side}Width`]));
    const style = node.styles[`border${side}Style`];
    if (!(w > 0) || ["none", "hidden"].includes(style)) return [];
    const color = safeColor(node.styles[`border${side}Color`]) || fallbackColor;
    if (!color) return [];
    const [line, length, insetLine] = geometryFor(w);
    const base = {type:"path", name:`${semanticLayerName(node)} · Border ${side.toLowerCase()}`, layoutPosition:"absolute", x:0, y:0, width, height,
      viewBox:[0, 0, width, height], fill:"#00000000", stroke:color, strokeWidth:w, strokeLinecap:"butt"};
    if (style === "dotted" && w >= 3) {
      const dots = sideDashes(length, w, w);
      return [dots ? {...base, geometry:insetLine(w / 2), strokeLinecap:"round", dashPattern:[0, round((length - w) / (dots.count - 1), 4)]} : {...base, geometry:line}];
    }
    const [dash, gap] = style === "dotted" ? [w, w] : style === "dashed" ? (w < 3 ? [w * 3, w * 2] : [w * 2, w]) : [0, 0];
    const fitted = dash ? sideDashes(length, dash, gap) : null;
    return [{...base, geometry:line, ...(fitted ? {dashPattern:[dash, round(fitted.gap, 4)]} : {})}];
  });
}

// `stroke-dasharray` in the SVG's units, scaled like the stroke; an odd list repeats once.
function svgDashes(value, scale) {
  const lengths = String(value || "").split(/[\s,]+/).filter(Boolean).map((part) => px(part, Number.NaN));
  if (!lengths.length || lengths.some((length) => !Number.isFinite(length) || length < 0) || lengths.every((length) => length === 0)) return {};
  return {dashPattern:(lengths.length % 2 ? [...lengths, ...lengths] : lengths).map((length) => round(length * scale))};
}

const isTransparentColor = (value) => value === "transparent" || /^rgba\(.*,\s*0\)$/.test(String(value)) || /\/\s*0%?\s*\)$/.test(String(value));

// Transparent text shows what is behind it: nothing, or the background it clips with
// `background-clip:text`.
function textFill(node, clippedBackground) {
  const color = node.namespace === "http://www.w3.org/2000/svg" ? node.styles.fill : node.styles.color;
  if (isTransparentColor(color)) return clippedBackground?.length ? clippedBackground : "#00000000";
  return safeColor(color) || "#000000";
}

function makeText(node, parent, name = `${semanticLayerName(node)} · Text`, run = null, clippedBackground = null, baseUrl = null) {
  const link = linkTarget(node.attributes.href, baseUrl);
  const fontSize = px(node.styles.fontSize, 14);
  const sourceRect = run?.rect || node.textRect || node.rect;
  const content = run?.text || node.text;
  const align = node.styles.textAlign === "center" || node.tag === "button" ? "center" : node.styles.textAlign === "right" ? "right" : "left";
  const lineHeight = px(node.styles.lineHeight, fontSize * 1.2);
  const singleLine = sourceRect.height <= lineHeight * 1.25;
  const intrinsicSingleLine = Boolean(run) || (singleLine
    && Math.abs(node.rect.width - sourceRect.width) <= 1.5
    && Math.abs(node.rect.height - sourceRect.height) <= 2);
  const widthCushion = singleLine ? Math.max(2, Math.min(6, sourceRect.width * 0.04)) : 0;
  const xCushion = align === "center" ? widthCushion / 2 : align === "right" ? widthCushion : 0;
  return {
    type:"text", name, layoutPosition:"absolute",
    x:round(sourceRect.x - parent.rect.x - (intrinsicSingleLine ? 0 : xCushion)), y:round(sourceRect.y - parent.rect.y),
    ...(intrinsicSingleLine ? {textGrowth:"auto"} : {width:round(sourceRect.width + widthCushion),height:round(sourceRect.height),textGrowth:"fixed-width-height"}),
    content:transformedText(node, content),
    fill:textFill(node, clippedBackground),
    fontFamily:fontFamily(node.styles.fontFamily, node.fontFamily), fontSize:round(fontSize), fontWeight:String(node.styles.fontWeight || "400"),
    fontStyle:node.styles.fontStyle || "normal", lineHeight:round(lineHeight / fontSize),
    ...(px(node.styles.letterSpacing) ? {letterSpacing:round(px(node.styles.letterSpacing))} : {}),
    measured:{width:round(sourceRect.width),height:round(sourceRect.height),lineHeight:round(lineHeight)},
    textAlign:align, textAlignVertical:node.tag === "button" ? "middle" : "top",
    ...(String(node.styles.textDecorationLine || "").includes("underline") ? {underline:true} : {}),
    ...(link ? {href:link,metadata:{type:"openpencil-capture-link",href:link}} : {}),
  };
}

// A link's target, absolute, for the schemes a design file can open.
function linkTarget(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl || undefined);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function makeTextUnderline(node, parent, name = `${semanticLayerName(node)} · Underline`, run = null) {
  if (!String(node.styles.textDecorationLine || "").includes("underline")) return null;
  const sourceRect = run?.rect || node.textRect || node.rect;
  const thicknessValue = px(node.styles.textDecorationThickness, 1);
  const thickness = Math.max(1,round(thicknessValue));
  return {
    type:"frame",name,layout:"none",layoutPosition:"absolute",
    x:round(sourceRect.x-parent.rect.x),y:round(sourceRect.y-parent.rect.y+sourceRect.height-thickness),
    width:round(sourceRect.width),height:thickness,
    fill:safeColor(node.styles.textDecorationColor) || safeColor(node.styles.color) || "#000000",
    ...(node.attributes.href ? {metadata:{type:"openpencil-capture-link-underline",href:node.attributes.href}} : {}),
  };
}

function controlText(node, parent) {
  if (!["input", "textarea", "select"].includes(node.tag) || !isVisible(node)) return null;
  // HTML reads `type` case-insensitively, so an older capture may say PASSWORD.
  const type = String(node.attributes.type || "").toLowerCase();
  if (["checkbox", "radio", "range", "file", "hidden"].includes(type)) return null;
  const value = node.attributes.selectedLabel || (type === "password" ? null : node.attributes.value) || node.attributes.maskedValue;
  const hasValue = Boolean(value);
  const content = value || node.attributes.placeholder;
  if (!content) return null;
  const fontSize = px(node.styles.fontSize, 14);
  const horizontalPadding = px(node.styles.paddingLeft, Math.min(12, Math.max(6, node.rect.height / 3)));
  const verticalPadding = px(node.styles.paddingTop, 0);
  const lineHeight = px(node.styles.lineHeight, fontSize * 1.2);
  const multiline = node.tag === "textarea";
  return {
    type:"text", name:`${semanticLayerName(node)} · Value`, layoutPosition:"absolute",
    x:round(node.rect.x - parent.rect.x + horizontalPadding), y:round(node.rect.y - parent.rect.y + (multiline ? verticalPadding : Math.max(0,(node.rect.height - lineHeight) / 2))),
    ...(multiline ? {width:round(Math.max(1,node.rect.width-horizontalPadding*2)),height:round(node.rect.height),textGrowth:"fixed-width-height"} : {textGrowth:"auto"}),
    content,
    fill:colorWithOpacity(safeColor(hasValue ? node.styles.color : node.attributes.placeholderColor), hasValue ? 1 : node.attributes.placeholderOpacity) || safeColor(node.styles.color) || "#000000", fontFamily:fontFamily(node.styles.fontFamily, node.fontFamily), fontSize:round(fontSize), fontWeight:String(node.styles.fontWeight || "400"),
    fontStyle:node.styles.fontStyle || "normal", lineHeight:round(lineHeight / fontSize),
    measured:{width:round(Math.max(1,node.rect.width-horizontalPadding*2)),height:round(multiline ? node.rect.height : lineHeight),lineHeight:round(lineHeight)},
    textAlign:"left", ...(multiline ? {textAlignVertical:"top"} : {}),
  };
}

function objectSize(fit, area, natural) {
  if (fit === "fill") return {width:area.width, height:area.height};
  const contain = Math.min(area.width / natural.width, area.height / natural.height);
  const scale = {contain, cover:Math.max(area.width / natural.width, area.height / natural.height), none:1, "scale-down":Math.min(1, contain)}[fit] ?? 1;
  return {width:natural.width * scale, height:natural.height * scale};
}

// Where an <img>'s pixels land in its box, as `object-fit` and `object-position` place them:
// the region they cover and the fill that paints it.
function imagePlacement(node, url) {
  const box = {x:0, y:0, width:node.rect.width, height:node.rect.height};
  const natural = {width:node.attributes.naturalWidth, height:node.attributes.naturalHeight};
  const fit = node.styles.objectFit || "fill";
  if (!(natural.width > 0 && natural.height > 0) || fit === "fill") {
    return {region:box, fill:{type:"image", url, mode:fit === "contain" ? "fit" : fit === "cover" ? "fill" : "stretch"}};
  }
  const [positionX = "50%", positionY = "50%"] = String(node.styles.objectPosition || "50% 50%").split(/\s+(?![^(]*\))/);
  const placed = placeImage({
    area:box, clip:box, size:objectSize(fit, box, natural), repeat:["no-repeat", "no-repeat"],
    position:{x:(range) => resolveLength(positionX, range) ?? range / 2, y:(range) => resolveLength(positionY, range) ?? range / 2},
  });
  if (!placed) return null;
  const exact = Math.abs(placed.image.x) <= 0.5 && Math.abs(placed.image.y) <= 0.5
    && Math.abs(placed.image.width - placed.region.width) <= 0.5 && Math.abs(placed.image.height - placed.region.height) <= 0.5;
  const centered = positionX === "50%" && positionY === "50%";
  const fill = exact ? {type:"image", url, mode:"stretch"}
    : fit === "cover" && centered ? {type:"image", url, mode:"fill"}
      : {type:"image", url, mode:"crop", imageRect:{x:round(placed.image.x), y:round(placed.image.y), width:round(placed.image.width), height:round(placed.image.height)}};
  return {region:{x:round(placed.region.x), y:round(placed.region.y), width:round(placed.region.width), height:round(placed.region.height)}, fill};
}

function cssBlendMode(value) {
  const modes = new Map([
    ["normal","normal"],["darken","darken"],["multiply","multiply"],["color-burn","colorBurn"],
    ["lighten","light"],["screen","screen"],["color-dodge","colorDodge"],["overlay","overlay"],
    ["soft-light","softLight"],["hard-light","hardLight"],["difference","difference"],["exclusion","exclusion"],
    ["hue","hue"],["saturation","saturation"],["color","color"],["luminosity","luminosity"],
  ]);
  return value === "normal" ? null : modes.get(value) || null;
}

// The filter functions of a `filter` value, in order, each with its argument text.
function filterFunctions(value) {
  if (!value || value === "none") return [];
  return Array.from(String(value).matchAll(/([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/gi), ([, name, args]) => ({name:name.toLowerCase(), args:args.trim()}));
}

const filterNumber = (value) => {
  const amount = Number.parseFloat(value);
  return String(value).trim().endsWith("%") ? amount / 100 : amount;
};

// What a filter becomes in the editor: blurs and drop shadows as effects, opacity() as layer
// opacity. Color functions stay for images, which take them in their pixels.
// Layers and effects whose colors already went through the filters that reach them.
const settled = new WeakSet();

function filterEffects(filter) {
  const effects = [];
  let opacity = 1;
  const functions = filterFunctions(filter);
  functions.forEach(({name, args}, index) => {
    if (name === "blur" && px(args) > 0) effects.push({type:"blur", kind:"layer", sigma:px(args)});
    if (name === "opacity" && Number.isFinite(filterNumber(args))) opacity *= clamp(filterNumber(args));
    if (name === "drop-shadow") {
      const [shadow] = parseCssShadows(args);
      // A shadow takes only the color functions applied after it.
      if (shadow) {
        const effect = {...shadow, spread:0, color:filterHex(shadow.color, colorFilterFunctions(functions.slice(index + 1)))};
        settled.add(effect);
        effects.push(effect);
      }
    }
  });
  return {effects, opacity};
}

// The color functions of an element's own filter reach every color it and its content paint.
function applyColorFilter(node, layer) {
  if (layer) filterTree(layer, colorFilterFunctions(filterFunctions(node.styles.filter)), settled);
  return layer;
}

function backdropEffects(value) {
  return filterFunctions(value).filter(({name, args}) => name === "blur" && px(args) > 0).map(({args}) => ({type:"blur", kind:"background", sigma:px(args)}));
}

// Color filters an image takes in its pixels; grayscale() and brightness() stay editable overlays.
const BAKED_FILTERS = new Set(["sepia", "invert", "saturate", "hue-rotate", "contrast"]);

function bakedFilter(filter) {
  return filterFunctions(filter).filter(({name}) => BAKED_FILTERS.has(name)).map(({name, args}) => `${name}(${args})`).join(" ");
}

function filterAmount(filter, name) {
  const value = filter?.match(new RegExp(`${name}\\(([^)]+)\\)`,`i`))?.[1]?.trim();
  if (!value) return null;
  const amount = value.endsWith("%") ? Number(value.slice(0,-1)) / 100 : Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function filteredImageNode(node, parent, url) {
  const rect = relativeRect(node,parent);
  const placement = imagePlacement(node, url);
  const filter = node.attributes.effectiveFilter && node.attributes.effectiveFilter !== "none"
    ? node.attributes.effectiveFilter
    : node.styles.filter;
  const grayscale = filterAmount(filter,"grayscale");
  const brightness = filterAmount(filter,"brightness");
  const darkened = Number.isFinite(brightness) && brightness >= 0 && brightness < 1;
  const baked = bakedFilter(filter);
  // The background is painted through the functions the pixels take; the overlays cover it too.
  const backgroundColor = filterHex(safeColor(node.styles.backgroundColor), colorFilterFunctions(filterFunctions(baked)));
  const radius = cornerRadius(node);
  const coversBox = placement && placement.region.x === 0 && placement.region.y === 0 && placement.region.width === rect.width && placement.region.height === rect.height;
  const metadata = filter && filter !== "none" ? {metadata:{type:"openpencil-capture-image",filter}} : {};
  if (placement && baked) placement.fill = {...placement.fill, filter:baked};
  const own = filterEffects(node.styles.filter);
  const effectProperties = {
    ...(own.effects.length ? {effect:own.effects.length === 1 ? own.effects[0] : own.effects} : {}),
    ...(own.opacity < 1 ? {opacity:round(own.opacity)} : {}),
  };
  if (!(grayscale > 0) && !darkened && !backgroundColor && (coversBox || !radius)) {
    if (!placement) return null;
    return {type:"rectangle",name:semanticLayerName(node),layoutPosition:"absolute",
      x:round(rect.x + placement.region.x),y:round(rect.y + placement.region.y),width:placement.region.width,height:placement.region.height,
      fill:placement.fill,...(coversBox ? {cornerRadius:radius} : {}),...metadata,...effectProperties};
  }
  const full = {layoutPosition:"absolute",x:0,y:0,width:rect.width,height:rect.height};
  const children = placement ? [{type:"rectangle",name:`${semanticLayerName(node)} · Source`,layoutPosition:"absolute",...placement.region,fill:placement.fill}] : [];
  if (grayscale > 0) children.push({type:"rectangle",name:`${semanticLayerName(node)} · Grayscale`,...full,fill:{type:"color",color:`#808080${Math.round(Math.min(1,grayscale)*255).toString(16).padStart(2,"0").toUpperCase()}`,blendMode:"saturation"}});
  if (darkened) children.push({type:"rectangle",name:`${semanticLayerName(node)} · Brightness`,...full,fill:`#000000${Math.round((1-brightness)*255).toString(16).padStart(2,"0").toUpperCase()}`});
  return {type:"frame",name:semanticLayerName(node),layout:"none",layoutPosition:"absolute",...rect,clip:true,cornerRadius:radius,
    ...(backgroundColor ? {fill:backgroundColor} : {}),metadata:{type:filter && filter !== "none" ? "openpencil-capture-image-filter" : "openpencil-capture-image",filter},...effectProperties,children};
}

// A primitive as path data in its own user space; percentages resolve against the viewBox.
function primitivePath(node, viewBox) {
  const [, , viewWidth = 0, viewHeight = 0] = viewBox;
  const length = (name, range, fallback = 0) => resolveLength(node.attributes[name], range) ?? fallback;
  const diagonal = Math.hypot(viewWidth, viewHeight) / Math.SQRT2;
  const ellipse = (cx, cy, rx, ry) => rx > 0 && ry > 0
    ? `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
    : null;
  if (node.tag === "rect") {
    const x = length("x", viewWidth); const y = length("y", viewHeight);
    const width = length("width", viewWidth); const height = length("height", viewHeight);
    if (!(width > 0 && height > 0)) return null;
    let rx = resolveLength(node.attributes.rx, viewWidth) ?? resolveLength(node.attributes.ry, viewHeight) ?? 0;
    let ry = resolveLength(node.attributes.ry, viewHeight) ?? rx;
    rx = Math.min(rx, width / 2); ry = Math.min(ry, height / 2);
    if (!(rx > 0 && ry > 0)) return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    return `M ${x + rx} ${y} H ${x + width - rx} A ${rx} ${ry} 0 0 1 ${x + width} ${y + ry} V ${y + height - ry} A ${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + height - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
  }
  if (node.tag === "circle") {
    const radius = length("r", diagonal);
    return ellipse(length("cx", viewWidth), length("cy", viewHeight), radius, radius);
  }
  if (node.tag === "ellipse") return ellipse(length("cx", viewWidth), length("cy", viewHeight), length("rx", viewWidth), length("ry", viewHeight));
  if (node.tag === "line") return `M ${length("x1", viewWidth)} ${length("y1", viewHeight)} L ${length("x2", viewWidth)} ${length("y2", viewHeight)}`;
  if (node.tag === "polyline" || node.tag === "polygon") {
    const numbers = node.attributes.points?.trim().split(/[\s,]+/).map(Number);
    if (!numbers?.length || numbers.length % 2 || numbers.some((value) => !Number.isFinite(value))) return null;
    const commands = [];
    for (let index = 0; index < numbers.length; index += 2) commands.push(`${index ? "L" : "M"} ${numbers[index]} ${numbers[index + 1]}`);
    return `${commands.join(" ")}${node.tag === "polygon" ? " Z" : ""}`;
  }
  if (node.tag === "path") return node.attributes.d || null;
  return null;
}

const hasRotation = (matrix) => Boolean(matrix) && (Math.abs(matrix[1]) > 1e-6 || Math.abs(matrix[2]) > 1e-6);

function svgGraphic(node, parent, byPath, paintServers) {
  let svg = node;
  while (svg && svg.tag !== "svg") svg = byPath.get(svg.parentPath);
  const viewBox = (svg?.attributes.viewBox || `0 0 ${svg?.rect.width || node.rect.width} ${svg?.rect.height || node.rect.height}`).split(/[\s,]+/).map(Number);
  const transform = node.attributes.transformMatrix || null;
  const transformScale = transform ? Math.sqrt(Math.abs(transform[0] * transform[3] - transform[1] * transform[2])) : 1;
  const strokeScale = svg && viewBox[2] > 0 && viewBox[3] > 0
    ? Math.min(svg.rect.width / viewBox[2], svg.rect.height / viewBox[3])
    : 1;
  const svgRelativeRect = svg ? {
    x:0, y:0, width:round(svg.rect.width), height:round(svg.rect.height),
  } : relativeRect(node, parent);
  const primitiveRect = svg ? {
    x:round(node.rect.x - svg.rect.x), y:round(node.rect.y - svg.rect.y), width:round(node.rect.width), height:round(node.rect.height),
  } : relativeRect(node, parent);
  // Lines, polylines and polygons are drawn in the SVG's own coordinates, and so is a primitive
  // that is turned, or copied by a <use> (its box is the <use>'s, not its own).
  const asPath = ["path", "line", "polyline", "polygon"].includes(node.tag) || node.synthetic === "use" || hasRotation(transform);
  // The shape's box in the SVG's own coordinates, through the viewBox's letterboxed scale.
  const [bx, by, bw, bh] = node.attributes.bbox || [];
  const userBox = bw > 0 && bh > 0 ? {x:bx, y:by, width:bw, height:bh} : svg && strokeScale > 0 ? {
    x:viewBox[0] + (node.rect.x - svg.rect.x - (svg.rect.width - viewBox[2] * strokeScale) / 2) / strokeScale,
    y:viewBox[1] + (node.rect.y - svg.rect.y - (svg.rect.height - viewBox[3] * strokeScale) / 2) / strokeScale,
    width:node.rect.width / strokeScale, height:node.rect.height / strokeScale,
  } : null;
  const paint = graphicPaint(node, strokeScale * (asPath ? transformScale : 1), paintServers, userBox);
  const base = { name:semanticLayerName(node), layoutPosition:"absolute", ...(asPath ? svgRelativeRect : primitiveRect), ...paint };
  if (asPath) {
    const geometry = primitivePath(node, viewBox);
    if (!geometry) return null;
    return {
      type:"path", ...base, geometry, viewBox,
      ...(transform ? {transform} : {}),
      ...(svg?.attributes.preserveAspectRatio === "none" ? {stretchViewBox:true} : {}),
    };
  }
  if (node.tag === "rect") return { type:"rectangle", ...base, cornerRadius:round(px(node.attributes.rx || node.attributes.ry) * strokeScale * transformScale) };
  if (node.tag === "circle" || node.tag === "ellipse") {
    // A progress ring draws one dash and a gap as long as the circle; other dash arrays are dashes.
    const dash = String(node.styles.strokeDasharray || "").match(/^([\d.]+)px[, ]+([\d.]+)px$/);
    const circumference = 2 * Math.PI * px(node.attributes.r || node.attributes.rx, 0);
    const ring = dash && Number(dash[2]) > 0 && (!circumference || Number(dash[2]) >= circumference * 0.98);
    const progress = ring ? clamp(Number(dash[1]) / Number(dash[2])) : 1;
    if (ring) delete base.dashPattern;
    if (progress < 0.999) {
      // A partial ellipse is a closed sector, so its stroke also draws
      // radial edges. Progress rings need an open SVG arc instead.
      const width = Math.max(1, base.width);
      const height = Math.max(1, base.height);
      const cx = width / 2;
      const cy = height / 2;
      const rx = width / 2;
      const ry = height / 2;
      const angle = Math.PI * 2 * progress;
      const endX = cx + rx * Math.cos(angle);
      const endY = cy + ry * Math.sin(angle);
      const largeArc = progress > 0.5 ? 1 : 0;
      return {
        type:"path", ...base, width, height,
        geometry:`M ${round(cx + rx)} ${round(cy)} A ${round(rx)} ${round(ry)} 0 ${largeArc} 1 ${round(endX)} ${round(endY)}`,
        viewBox:[0, 0, width, height],
      };
    }
    return { type:"ellipse", ...base };
  }
  return null;
}

// A paint server's stops, with each stop's opacity folded into its color.
function paintServerStops(node, childPaths, byPath) {
  return (childPaths.get(node.path) || []).map((path) => byPath.get(path)).filter((child) => child?.tag === "stop").flatMap((stop) => {
    const color = safeColor(stop.styles.stopColor || stop.attributes["stop-color"]);
    if (!color) return [];
    const rawOffset = stop.attributes.offset || "0";
    const position = rawOffset.endsWith("%") ? px(rawOffset) / 100 : px(rawOffset);
    return [{color:colorWithCombinedOpacity(color,stop.styles.stopOpacity || stop.attributes["stop-opacity"]),position:clamp(position)}];
  });
}

// SVG gradients, by id, in fractions of the painted shape's box (objectBoundingBox, the default).
function svgPaintServers(capture, childPaths, byPath) {
  const servers = new Map();
  const fraction = (value, fallback) => {
    if (value == null || value === "") return fallback;
    return String(value).endsWith("%") ? px(value) / 100 : px(value, fallback);
  };
  for (const node of capture.nodes) {
    if (node.namespace !== "http://www.w3.org/2000/svg" || !node.attributes.id) continue;
    if (node.tag !== "lineargradient" && node.tag !== "radialgradient") continue;
    const stops = paintServerStops(node, childPaths, byPath);
    if (stops.length < 2) continue;
    if (node.tag === "radialgradient") {
      const radius = fraction(node.attributes.r, 0.5);
      const userSpace = node.attributes.gradientUnits === "userSpaceOnUse"
        ? {cx:px(node.attributes.cx, 0), cy:px(node.attributes.cy, 0), r:px(node.attributes.r, 0)}
        : null;
      servers.set(node.attributes.id, {type:"gradient", gradientType:"radial", center:{x:fraction(node.attributes.cx, 0.5), y:fraction(node.attributes.cy, 0.5)}, radius:{x:radius, y:radius}, colors:stops, ...(userSpace ? {userSpace} : {})});
      continue;
    }
    const x1 = fraction(node.attributes.x1, 0); const y1 = fraction(node.attributes.y1, 0);
    const x2 = fraction(node.attributes.x2, 1); const y2 = fraction(node.attributes.y2, 0);
    const rotation = ((Math.atan2(-(x2-x1),-(y2-y1))*180/Math.PI)%360+360)%360;
    servers.set(node.attributes.id, {type:"gradient", gradientType:"linear", rotation:round(rotation), colors:stops});
  }
  return servers;
}

const SVG_SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

export function convertCaptureToTree(capture) {
  if (capture?.format !== "openpencil-capture-ir" || capture?.version !== 1) throw new Error("Unsupported capture format");
  const byPath = new Map(capture.nodes.map((node) => [node.path, node]));
  const rootSource = byPath.get(capture.rootPath);
  if (!rootSource) throw new Error("Capture root is missing");
  const childPaths = new Map();
  for (const node of capture.nodes) {
    if (!childPaths.has(node.parentPath)) childPaths.set(node.parentPath, []);
    childPaths.get(node.parentPath).push(node.path);
  }
  const paintServers = svgPaintServers(capture, childPaths, byPath);
  const resources = (tag) => new Map(capture.nodes.filter((node) => node.tag === tag && node.attributes.id).map((node) => [node.attributes.id, {
    node, shapes:(childPaths.get(node.path) || []).map((path) => byPath.get(path)).filter((shape) => SVG_SHAPES.has(shape.tag)),
  }]));
  const maskContext = {clipPaths:resources("clippath"), masks:resources("mask"), paintServers, svgOf:(node) => {
    let svg = node;
    while (svg && svg.tag !== "svg") svg = byPath.get(svg.parentPath);
    return svg;
  }};
  const stats = { frames:0, groups:0, texts:0, images:0, gradients:0, svgGraphics:0, controls:0, skipped:0, skippedSvgInvisible:0, skippedSvgUnsupported:0, skippedRoots:{} };
  const convertNode = (node, parent, clippedBackground = null) => {
    if (node.namespace === "http://www.w3.org/2000/svg" && ["defs", "clippath", "title", "desc"].includes(node.tag)) {
      stats.skipped += 1;
      stats.skippedSvgInvisible += 1;
      stats.skippedRoots[node.tag] = (stats.skippedRoots[node.tag] || 0) + 1;
      return null;
    }
    if ((!isCssShown(node) && !isVisibleSvgContainer(node)) || isVisuallyHiddenControl(node) || isVisuallyHiddenElement(node)) {
      stats.skipped += 1;
      if (node.namespace === "http://www.w3.org/2000/svg") stats.skippedSvgInvisible += 1;
      stats.skippedRoots[node.tag] = (stats.skippedRoots[node.tag] || 0) + 1;
      return null;
    }
    if (!isVisible(node) && !isVisibleSvgContainer(node) && !isVisibleSvgGraphic(node)) {
      const descendants = childPaths.get(node.path) || [];
      if (descendants.length) {
        const bridge = {type:"group",name:semanticLayerName(node),layoutPosition:"absolute",x:0,y:0,children:[]};
        stats.groups += 1;
        for (const path of descendants) {
          const child = convertNode(byPath.get(path), parent, clippedBackground);
          if (child) bridge.children.push(child);
        }
        if (bridge.children.length) return bridge;
      }
      stats.skipped += 1;
      stats.skippedRoots[node.tag] = (stats.skippedRoots[node.tag] || 0) + 1;
      return null;
    }
    if (["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(node.tag) && node.namespace === "http://www.w3.org/2000/svg") {
      const graphic = svgGraphic(node, parent, byPath, paintServers);
      if (graphic) {
        stats.svgGraphics += 1;
        if (graphic.fill?.type === "gradient") stats.gradients += 1;
      }
      else stats.skippedSvgUnsupported += 1;
      return withCssMasks(node, applyColorFilter(node, graphic), capture, maskContext);
    }
    // A list marker's disc, circle or square, painted as Chromium paints it: a shape, not a glyph.
    if (node.attributes.markerSymbol) {
      const color = safeColor(node.styles.color) || "#000000";
      const shape = {name:`${semanticLayerName(byPath.get(node.parentPath) || node)} · Marker`, layoutPosition:"absolute", ...relativeRect(node, parent)};
      stats.frames += 1;
      if (node.attributes.markerSymbol === "square") return {type:"rectangle", ...shape, fill:color};
      // Chromium's canonical disclosure triangles, in the unit square of the marker's box.
      const triangle = {"disclosure-closed":[[0, 0], [0.86, 0.5], [0, 1]], "disclosure-open":[[0, 0.07], [0.5, 0.93], [1, 0.07]]}[node.attributes.markerSymbol];
      if (triangle) {
        return {type:"path", ...shape, viewBox:[0, 0, shape.width, shape.height], fill:color,
          geometry:`${triangle.map(([x, y], index) => `${index ? "L" : "M"} ${round(x * shape.width)} ${round(y * shape.height)}`).join(" ")} Z`};
      }
      if (node.attributes.markerSymbol === "circle") return {type:"ellipse", ...shape, fill:"#00000000", stroke:color, strokeWidth:1};
      return {type:"ellipse", ...shape, fill:color};
    }
    if (node.tag === "img" || node.tag === "canvas") {
      const url = node.tag === "canvas"
        ? node.attributes.dataUrl
        : assetUrl(node.attributes.currentSrc || node.attributes.src,capture.source?.url);
      if (!url && node.tag === "canvas") {
        stats.frames += 1;
        return {
          type:"frame",name:"Canvas · Snapshot unavailable",layout:"none",layoutPosition:"absolute",
          ...relativeRect(node,parent),metadata:{type:"openpencil-capture-unavailable-canvas",reason:"tainted-canvas"},children:[],
        };
      }
      if (!url) { stats.skipped += 1; return null; }
      stats.images += 1;
      // An <img> already takes the filters of its ancestors; they must not reach it twice.
      if (node.tag === "img") {
        const image = filteredImageNode(node,parent,url);
        if (image) settled.add(image);
        return withCssMasks(node, image, capture, maskContext);
      }
      return withCssMasks(node, applyColorFilter(node, {type:"rectangle",name:semanticLayerName(node),layoutPosition:"absolute",...relativeRect(node,parent),fill:{type:"image",url,mode:"stretch"},cornerRadius:cornerRadius(node)}), capture, maskContext);
    }
    // A frame shows its document's canvas background, which the element it came from no longer paints.
    const propagated = node.attributes.backgroundPropagated;
    const backgroundColor = propagated ? null : safeColor(node.attributes.canvasBackground || node.styles.backgroundColor);
    const blendMode = cssBlendMode(node.styles.mixBlendMode);
    const layers = propagated ? [] : backgroundLayers(node, capture);
    // A single striped gradient stays editable as stripes rather than a many-stop gradient.
    const repeatingPattern = layers.length === 1 && !layers[0].region ? repeatingLinearPattern(node) : null;
    const withBlend = (fill) => blendMode ? (typeof fill === "string" ? {type:"color",color:fill,blendMode} : {...fill,blendMode}) : fill;
    // The editor paints a frame's fills under its children, so once one layer needs a rectangle
    // of its own, every layer above it does too.
    const firstPartial = layers.findIndex((layer) => layer.region);
    const fillLayers = repeatingPattern ? [] : firstPartial === -1 ? layers : layers.slice(0, firstPartial);
    const childLayers = repeatingPattern || firstPartial === -1 ? [] : layers.slice(firstPartial);
    const clipsText = String(node.styles.backgroundClip).split(",").some((value) => value.trim() === "text");
    const fills = [...(backgroundColor ? [backgroundColor] : []), ...fillLayers.map((layer) => layer.fill)].map(withBlend);
    const textBackground = clipsText ? fills : clippedBackground;
    const shadows = parseCssShadows(node.styles.boxShadow);
    const border = Object.keys(borderProperties(node.styles)).length ? borderProperties(node.styles) : shadowRingBorder(shadows);
    const filtered = filterEffects(node.styles.filter);
    const effects = [
      ...shadows.filter((shadow) => !(border.stroke === shadow.color && border.strokeWidth === shadow.spread && shadow.offset.x === 0 && shadow.offset.y === 0 && shadow.blur === 0)),
      ...filtered.effects, ...backdropEffects(node.styles.backdropFilter || node.styles.webkitBackdropFilter),
    ];
    const layerOpacity = px(node.styles.opacity, 1) * filtered.opacity;
    let frameRect = relativeRect(node, parent);
    if (node.namespace === "http://www.w3.org/2000/svg" && node.tag === "g") {
      let svg = node;
      while (svg && svg.tag !== "svg") svg = byPath.get(svg.parentPath);
      if (svg) frameRect = {x:0,y:0,width:round(svg.rect.width),height:round(svg.rect.height)};
    } else if (node.namespace === "http://www.w3.org/2000/svg" && byPath.get(node.parentPath)?.tag === "g") {
      let svg = node;
      while (svg && svg.tag !== "svg") svg = byPath.get(svg.parentPath);
      if (svg) frameRect = {x:round(node.rect.x-svg.rect.x),y:round(node.rect.y-svg.rect.y),width:round(node.rect.width),height:round(node.rect.height)};
    }
    // Scrolled content is clipped like hidden content; the capture keeps the scroll position.
    const clipped = node.tag === "iframe" || node.tag === "frame" || [node.styles.overflowX, node.styles.overflowY, ...String(node.styles.overflow || "").split(/\s+/)].some((value) => ["hidden", "clip", "auto", "scroll"].includes(value));
    const isHtmlElement = node.namespace !== "http://www.w3.org/2000/svg";
    const framed = node.path === capture.rootPath || isHtmlElement || Boolean(repeatingPattern || layers.length || backgroundColor || border.stroke || effects.length || clipped);
    const frame = framed ? {
      type:"frame", name:semanticLayerName(node), layout:"none", layoutPosition:"absolute",
      ...frameRect, cornerRadius:cornerRadius(node),
      ...(!clipsText && fills.length ? {fill:fills.length === 1 ? fills[0] : fills} : {}),
      ...border, ...(effects.length ? { effect:effects.length === 1 ? effects[0] : effects } : {}), ...(clipped ? { clip:true } : {}),
      ...(layerOpacity < 1 ? { opacity:round(layerOpacity) } : {}), children:[],
    } : {
      type:"group", name:semanticLayerName(node), layoutPosition:"absolute", x:frameRect.x, y:frameRect.y,
      ...(layerOpacity < 1 ? { opacity:round(layerOpacity) } : {}), children:[],
    };
    if (framed) stats.frames += 1; else stats.groups += 1;
    const elliptical = framed && !clipsText ? ellipticalCorners(node) : null;
    if (elliptical) {
      const shadowEffects = effects.filter((effect) => effect.type === "shadow");
      const others = effects.filter((effect) => effect.type !== "shadow");
      frame.children.push(...ellipticalBoxLayers(node, elliptical, {fills, border, shadows:shadowEffects}));
      for (const key of ["fill", "stroke", "strokeWidth", "strokeAlignment", "dashPattern", "effect"]) delete frame[key];
      if (others.length) frame.effect = others.length === 1 ? others[0] : others;
    }
    if (!clipsText) {
      childLayers.forEach((layer, index) => frame.children.push({
        type:"rectangle",name:`${semanticLayerName(node)} · Background image${childLayers.length > 1 ? ` ${index + 1}` : ""}`,layoutPosition:"absolute",
        ...(layer.region || {x:0,y:0,width:frameRect.width,height:frameRect.height}),
        ...(layer.region ? {} : {cornerRadius:cornerRadius(node)}),fill:withBlend(layer.fill),
      }));
      if (repeatingPattern) frame.children.push(repeatingPattern);
    }
    // Square corners let each side of a dashed border be its own line, dashed from its corners;
    // round ones dash it as one loop along the middle of the border.
    if (framed && !elliptical && border.dashPattern && border.stroke) {
      const radii = [cornerRadius(node)].flat();
      const corners = radii.length === 1 ? [radii[0], radii[0], radii[0], radii[0]] : radii;
      // Chromium dashes a rounded border as a loop once its inner edge is rounded too.
      if (corners.every((radius) => typeof border.strokeWidth === "number" ? radius <= border.strokeWidth : radius === 0)) frame.children.push(...borderSideLines(node, border.stroke));
      else if (typeof border.strokeWidth === "number") {
        const w = border.strokeWidth;
        const box = {x:w / 2, y:w / 2, width:frameRect.width - w, height:frameRect.height - w};
        const middle = corners.map((radius) => radius > w / 2 ? [radius - w / 2, radius - w / 2] : [0, 0]);
        const style = ["Top", "Right", "Bottom", "Left"].map((side) => node.styles[`border${side}Style`]).find((value) => value === "dashed" || value === "dotted");
        frame.children.push({type:"path", name:`${semanticLayerName(node)} · Border`, layoutPosition:"absolute", x:0, y:0, width:frameRect.width, height:frameRect.height,
          viewBox:[0, 0, frameRect.width, frameRect.height], geometry:roundedBoxPath(box, middle), fill:"#00000000", stroke:border.stroke, strokeWidth:w,
          ...loopDashes(style, w, outlinePerimeter(box, measuredCorners(middle)))});
      }
      if (frame.children.length && frame.children.at(-1).name?.includes(" · Border")) for (const key of ["stroke", "strokeWidth", "strokeAlignment", "dashPattern"]) delete frame[key];
    }
    for (const layer of layers) {
      if (layer.fill.type === "image" && !layer.fill.gradient) stats.images += 1;
      else stats.gradients += 1;
    }
    const textRuns = Array.isArray(node.textRuns)
      ? node.textRuns.filter((run) => run?.text && run.rect?.width > 0 && run.rect?.height > 0)
      : [];
    if (textRuns.length) {
      textRuns.forEach((run, index) => {
        const suffix = textRuns.length > 1 ? ` · Line ${index + 1}` : "";
        frame.children.push(makeText(node,node,`${semanticLayerName(node)} · Text${suffix}`,run,textBackground,capture.source?.url));
        const underline = makeTextUnderline(node,node,`${semanticLayerName(node)} · Underline${suffix}`,run);
        if (underline) { frame.children.push(underline); stats.frames += 1; }
      });
      stats.texts += textRuns.length;
    } else if (node.text && (!node.textRect || (node.textRect.width > 0 && node.textRect.height > 0))) {
      frame.children.push(makeText(node, node, undefined, null, textBackground, capture.source?.url));
      const underline = makeTextUnderline(node,node);
      if (underline) { frame.children.push(underline); stats.frames += 1; }
      stats.texts += 1;
    }
    const control = controlText(node, node);
    if (control) { frame.children.push(control); stats.controls += 1; }
    for (const path of childPaths.get(node.path) || []) {
      const child = convertNode(byPath.get(path), node, textBackground);
      if (child) frame.children.push(child);
    }
    return withCssMasks(node, applyColorFilter(node, frame), capture, maskContext);
  };
  const root = convertNode(rootSource, { rect:{ x:0, y:0 } });
  if (!root) throw new Error("The selected element is not visible");
  root.name = `Captured · ${inferTitle(capture, rootSource)}`;
  root.x = 0;
  root.y = 0;
  root.layoutPosition = undefined;
  if (!root.clip) root.clip = false;
  return { format:"capture-node-tree", version:2, source:capture.source, stats, root };
}
