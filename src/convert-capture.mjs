import { cssBackgroundLayers, placeImage, resolveLength } from "./css-background.mjs";
import { colorWithCombinedOpacity, colorWithOpacity, gradientColor, safeColor } from "./css-color.mjs";
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

function graphicPaint(node, strokeScale = 1, paintServers = new Map()) {
  const paintReference = node.styles.fill?.match(/^url\(["']?#([^"')]+)["']?\)$/i)?.[1];
  const referencedFill = paintReference ? paintServers.get(paintReference) : null;
  const fill = referencedFill
    ? {...referencedFill,colors:referencedFill.colors.map((stop) => ({...stop,color:colorWithCombinedOpacity(stop.color,node.styles.fillOpacity)}))}
    : colorWithOpacity(safeColor(node.styles.fill), node.styles.fillOpacity);
  const stroke = colorWithOpacity(safeColor(node.styles.stroke), node.styles.strokeOpacity);
  return {
    fill:fill || "#00000000",
    ...(stroke ? { stroke, strokeWidth:round(px(node.styles.strokeWidth, 1) * strokeScale), strokeLinecap:"round", strokeLinejoin:"round" } : {}),
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
  const visible = sides.find((side) => widths[side.toLowerCase()] > 0 && styles[`border${side}Style`] !== "none" && safeColor(styles[`border${side}Color`]));
  if (!visible) return {};
  return {
    stroke:safeColor(styles[`border${visible}Color`]),
    strokeWidth:widths.top === widths.right && widths.top === widths.bottom && widths.top === widths.left ? widths.top : widths,
    strokeAlignment:"inner",
  };
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
  if (["checkbox", "radio", "range", "file", "hidden"].includes(node.attributes.type)) return null;
  const value = node.attributes.selectedLabel || (node.attributes.type === "password" ? null : node.attributes.value) || node.attributes.maskedValue;
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
  const backgroundColor = safeColor(node.styles.backgroundColor);
  const radius = cornerRadius(node);
  const coversBox = placement && placement.region.x === 0 && placement.region.y === 0 && placement.region.width === rect.width && placement.region.height === rect.height;
  const metadata = filter && filter !== "none" ? {metadata:{type:"openpencil-capture-image",filter}} : {};
  if (!(grayscale > 0) && !darkened && !backgroundColor && (coversBox || !radius)) {
    if (!placement) return null;
    return {type:"rectangle",name:semanticLayerName(node),layoutPosition:"absolute",
      x:round(rect.x + placement.region.x),y:round(rect.y + placement.region.y),width:placement.region.width,height:placement.region.height,
      fill:placement.fill,...(coversBox ? {cornerRadius:radius} : {}),...metadata};
  }
  const full = {layoutPosition:"absolute",x:0,y:0,width:rect.width,height:rect.height};
  const children = placement ? [{type:"rectangle",name:`${semanticLayerName(node)} · Source`,layoutPosition:"absolute",...placement.region,fill:placement.fill}] : [];
  if (grayscale > 0) children.push({type:"rectangle",name:`${semanticLayerName(node)} · Grayscale`,...full,fill:{type:"color",color:`#808080${Math.round(Math.min(1,grayscale)*255).toString(16).padStart(2,"0").toUpperCase()}`,blendMode:"saturation"}});
  if (darkened) children.push({type:"rectangle",name:`${semanticLayerName(node)} · Brightness`,...full,fill:`#000000${Math.round((1-brightness)*255).toString(16).padStart(2,"0").toUpperCase()}`});
  return {type:"frame",name:semanticLayerName(node),layout:"none",layoutPosition:"absolute",...rect,clip:true,cornerRadius:radius,
    ...(backgroundColor ? {fill:backgroundColor} : {}),metadata:{type:filter && filter !== "none" ? "openpencil-capture-image-filter" : "openpencil-capture-image",filter},children};
}

function svgGraphic(node, parent, byPath, paintServers) {
  let svg = node;
  while (svg && svg.tag !== "svg") svg = byPath.get(svg.parentPath);
  const viewBox = (svg?.attributes.viewBox || `0 0 ${svg?.rect.width || node.rect.width} ${svg?.rect.height || node.rect.height}`).split(/[\s,]+/).map(Number);
  const strokeScale = svg && viewBox[2] > 0 && viewBox[3] > 0
    ? Math.min(svg.rect.width / viewBox[2], svg.rect.height / viewBox[3])
    : 1;
  const svgRelativeRect = svg ? {
    x:0, y:0, width:round(svg.rect.width), height:round(svg.rect.height),
  } : relativeRect(node, parent);
  const primitiveRect = svg ? {
    x:round(node.rect.x - svg.rect.x), y:round(node.rect.y - svg.rect.y), width:round(node.rect.width), height:round(node.rect.height),
  } : relativeRect(node, parent);
  const base = { name:semanticLayerName(node), layoutPosition:"absolute", ...(node.tag === "path" ? svgRelativeRect : primitiveRect), ...graphicPaint(node, strokeScale, paintServers) };
  if (node.tag === "rect") return { type:"rectangle", ...base, cornerRadius:round(px(node.attributes.rx || node.attributes.ry)) };
  if (node.tag === "circle" || node.tag === "ellipse") {
    const dash = String(node.styles.strokeDasharray || "").match(/([\d.]+)px[, ]+([\d.]+)px/);
    const progress = dash && Number(dash[2]) > 0 ? clamp(Number(dash[1]) / Number(dash[2])) : 1;
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
  if (node.tag === "line") {
    const width = Math.max(1, base.width);
    const height = Math.max(1, base.height);
    return { type:"path", ...base, width, height, geometry:`M 0 0 L ${base.width === 0 ? 0 : width} ${base.height === 0 ? 0 : height}`, viewBox:[0, 0, width, height] };
  }
  if (node.tag === "polyline" || node.tag === "polygon") {
    const numbers = node.attributes.points?.trim().split(/[\s,]+/).map(Number);
    if (!numbers?.length || numbers.some((value) => !Number.isFinite(value))) return null;
    const points = [];
    for (let index = 0; index < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]]);
    const xs = points.map(([x]) => x); const ys = points.map(([, y]) => y);
    const commands = points.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
    return { type:"path", ...base, geometry:`${commands}${node.tag === "polygon" ? " Z" : ""}`, viewBox:[Math.min(...xs), Math.min(...ys), Math.max(1, Math.max(...xs) - Math.min(...xs)), Math.max(1, Math.max(...ys) - Math.min(...ys))] };
  }
  if (node.tag === "path" && node.attributes.d) {
    return { type:"path", ...base, geometry:node.attributes.d, viewBox, ...(svg?.attributes.preserveAspectRatio === "none" ? {stretchViewBox:true} : {}) };
  }
  return null;
}

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
  const paintServers = new Map();
  for (const node of capture.nodes) {
    if (node.namespace !== "http://www.w3.org/2000/svg" || node.tag !== "lineargradient" || !node.attributes.id) continue;
    const stops = (childPaths.get(node.path) || []).map((path) => byPath.get(path)).filter((child) => child?.tag === "stop").flatMap((stop) => {
      const color = safeColor(stop.styles.stopColor || stop.attributes["stop-color"]);
      if (!color) return [];
      const rawOffset = stop.attributes.offset || "0";
      const position = rawOffset.endsWith("%") ? px(rawOffset) / 100 : px(rawOffset);
      return [{color:colorWithCombinedOpacity(color,stop.styles.stopOpacity || stop.attributes["stop-opacity"]),position:clamp(position)}];
    });
    if (stops.length < 2) continue;
    const x1 = px(node.attributes.x1,0); const y1 = px(node.attributes.y1,0);
    const x2 = px(node.attributes.x2,0); const y2 = px(node.attributes.y2,1);
    const rotation = ((Math.atan2(-(x2-x1),-(y2-y1))*180/Math.PI)%360+360)%360;
    paintServers.set(node.attributes.id,{type:"gradient",gradientType:"linear",rotation:round(rotation),colors:stops});
  }
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
      return graphic;
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
      if (node.tag === "img") return filteredImageNode(node,parent,url);
      return {type:"rectangle",name:semanticLayerName(node),layoutPosition:"absolute",...relativeRect(node,parent),fill:{type:"image",url,mode:"stretch"},cornerRadius:cornerRadius(node)};
    }
    const backgroundColor = safeColor(node.styles.backgroundColor);
    const blendMode = cssBlendMode(node.styles.mixBlendMode);
    const layers = backgroundLayers(node, capture);
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
    const effects = shadows.filter((shadow) => !(border.stroke === shadow.color && border.strokeWidth === shadow.spread && shadow.offset.x === 0 && shadow.offset.y === 0 && shadow.blur === 0));
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
    const clipped = [node.styles.overflowX, node.styles.overflowY, ...String(node.styles.overflow || "").split(/\s+/)].some((value) => ["hidden", "clip", "auto", "scroll"].includes(value));
    const isHtmlElement = node.namespace !== "http://www.w3.org/2000/svg";
    const framed = node.path === capture.rootPath || isHtmlElement || Boolean(repeatingPattern || layers.length || backgroundColor || border.stroke || effects.length || clipped);
    const frame = framed ? {
      type:"frame", name:semanticLayerName(node), layout:"none", layoutPosition:"absolute",
      ...frameRect, cornerRadius:cornerRadius(node),
      ...(!clipsText && fills.length ? {fill:fills.length === 1 ? fills[0] : fills} : {}),
      ...border, ...(effects.length ? { effect:effects.length === 1 ? effects[0] : effects } : {}), ...(clipped ? { clip:true } : {}),
      ...(px(node.styles.opacity, 1) < 1 ? { opacity:round(px(node.styles.opacity, 1)) } : {}), children:[],
    } : {
      type:"group", name:semanticLayerName(node), layoutPosition:"absolute", x:frameRect.x, y:frameRect.y,
      ...(px(node.styles.opacity, 1) < 1 ? { opacity:round(px(node.styles.opacity, 1)) } : {}), children:[],
    };
    if (framed) stats.frames += 1; else stats.groups += 1;
    if (!clipsText) {
      childLayers.forEach((layer, index) => frame.children.push({
        type:"rectangle",name:`${semanticLayerName(node)} · Background image${childLayers.length > 1 ? ` ${index + 1}` : ""}`,layoutPosition:"absolute",
        ...(layer.region || {x:0,y:0,width:frameRect.width,height:frameRect.height}),
        ...(layer.region ? {} : {cornerRadius:cornerRadius(node)}),fill:withBlend(layer.fill),
      }));
      if (repeatingPattern) frame.children.push(repeatingPattern);
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
    return frame;
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
