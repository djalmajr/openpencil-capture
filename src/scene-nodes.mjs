import { ellipticalGradientTransform, linearGradientTransform } from "@open-pencil/scene-graph/gradient";
import { parseSVGPath } from "@open-pencil/scene-graph/parse-path";

const BLEND_MODES = {
  normal:"NORMAL", darken:"DARKEN", multiply:"MULTIPLY", colorBurn:"COLOR_BURN",
  light:"LIGHTEN", screen:"SCREEN", colorDodge:"COLOR_DODGE", overlay:"OVERLAY",
  softLight:"SOFT_LIGHT", hardLight:"HARD_LIGHT", difference:"DIFFERENCE", exclusion:"EXCLUSION",
  hue:"HUE", saturation:"SATURATION", color:"COLOR", luminosity:"LUMINOSITY",
};
const IMAGE_SCALE_MODES = {fit:"FIT", fill:"FILL", stretch:"CROP", crop:"CROP", tile:"TILE"};
const STROKE_CAPS = {round:"ROUND", square:"SQUARE", butt:"NONE"};
const STROKE_JOINS = {round:"ROUND", bevel:"BEVEL", miter:"MITER"};
const IDENTITY_TRANSFORM = {m00:1, m01:0, m02:0, m10:0, m11:1, m12:0};
const TRANSPARENT = {r:0, g:0, b:0, a:0};

const round = (value) => Number(value.toFixed(4));

export function hexToColor(hex) {
  const value = hex.slice(1);
  const pairs = value.length <= 4 ? [...value].map((digit) => digit + digit) : value.match(/../g);
  const [r, g, b, a = 255] = pairs.map((pair) => Number.parseInt(pair, 16));
  return {r:r / 255, g:g / 255, b:b / 255, a:a / 255};
}

// Shapes take a paint's alpha from `opacity` and text multiplies both, so `color.a` stays 1.
function solidPaint(hex) {
  const {a, ...rgb} = hexToColor(hex);
  return {type:"SOLID", color:{...rgb, a:1}, opacity:a, visible:true};
}

// CSS interpolates premultiplied, so a fully transparent stop fades toward its neighbor's hue.
// The editor interpolates channels straight, and would pass through whatever RGB that stop holds.
function gradientStops(colors) {
  const stops = colors.map((stop) => ({color:hexToColor(stop.color), position:stop.position}));
  return stops.map((stop, index) => {
    if (stop.color.a > 0) return stop;
    const neighbor = stops.slice(index + 1).find((other) => other.color.a > 0)
      ?? stops.slice(0, index).findLast((other) => other.color.a > 0);
    return neighbor ? {...stop, color:{...neighbor.color, a:0}} : stop;
  });
}

// Radial and angular gradients are centred on (0.5, 0.5) of gradient space with radius 0.5; the
// two radii given here, in the layer's unit square, map it onto the box.
function ellipticalPaint(fill, width, height) {
  const center = fill.center || {x:0.5, y:0.5};
  if (fill.gradientType === "radial") {
    return {
      type:"GRADIENT_RADIAL", color:TRANSPARENT, opacity:1, visible:true, gradientStops:gradientStops(fill.colors),
      gradientTransform:ellipticalGradientTransform(center, {x:center.x + fill.radius.x, y:center.y}, {x:center.x, y:center.y + fill.radius.y}),
    };
  }
  // An angular gradient starts along gradient space's +x and turns clockwise; CSS's conic one
  // starts straight up, so +x points `rotation` degrees clockwise from up, with equal radii on screen.
  const angle = fill.rotation * Math.PI / 180;
  const radius = Math.max(width, height, 1) / 2;
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  return {
    type:"GRADIENT_ANGULAR", color:TRANSPARENT, opacity:1, visible:true, gradientStops:gradientStops(fill.colors),
    gradientTransform:ellipticalGradientTransform(
      center,
      {x:center.x + radius * Math.sin(angle) / safeWidth, y:center.y - radius * Math.cos(angle) / safeHeight},
      {x:center.x + radius * Math.cos(angle) / safeWidth, y:center.y + radius * Math.sin(angle) / safeHeight},
    ),
  };
}

function gradientPaint(fill, width, height) {
  if (fill.gradientType === "radial" || fill.gradientType === "angular") return ellipticalPaint(fill, width, height);
  const angle = (360 - fill.rotation) * Math.PI / 180;
  const direction = {x:Math.sin(angle), y:-Math.cos(angle)};
  const length = Math.abs(width * direction.x) + Math.abs(height * direction.y);
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const point = (sign) => ({
    x:0.5 + sign * direction.x * length / 2 / safeWidth,
    y:0.5 + sign * direction.y * length / 2 / safeHeight,
  });
  return {
    type:"GRADIENT_LINEAR", color:TRANSPARENT, opacity:1, visible:true,
    gradientStops:gradientStops(fill.colors),
    gradientTransform:linearGradientTransform(point(-1), point(1), safeWidth, safeHeight),
  };
}

// `imageRect` is where the image (one tile of it, when tiled) lands in the layer, in pixels. The
// editor's `imageTransform` maps the layer's unit square onto the image's.
function imageTransform(rect, width, height) {
  if (!rect) return IDENTITY_TRANSFORM;
  return {
    m00:round(Math.max(width, 1) / rect.width), m01:0, m02:round(-rect.x / rect.width),
    m10:0, m11:round(Math.max(height, 1) / rect.height), m12:round(-rect.y / rect.height),
  };
}

function imagePaint(fill, imageHash, width, height) {
  const imageScaleMode = IMAGE_SCALE_MODES[fill.mode] || "FILL";
  return {
    type:"IMAGE", color:TRANSPARENT, opacity:1, visible:true, imageHash, imageScaleMode,
    ...(imageScaleMode === "CROP" || (imageScaleMode === "TILE" && fill.imageRect) ? {imageTransform:imageTransform(fill.imageRect, width, height)} : {}),
  };
}

// A list of fills paints bottom first, as the editor draws them.
function toFills(fill, width, height, imageHashes) {
  if (!fill) return [];
  if (Array.isArray(fill)) return fill.flatMap((layer) => toFills(layer, width, height, imageHashes));
  const paint = () => {
    if (typeof fill === "string") return solidPaint(fill);
    if (fill.type === "color") return solidPaint(fill.color);
    if (fill.type === "gradient") return gradientPaint(fill, width, height);
    const hash = imageHashes.get(fill.url);
    return hash ? imagePaint(fill, hash, width, height) : null;
  };
  const result = paint();
  if (!result || (result.type === "SOLID" && result.opacity === 0)) return [];
  const blendMode = BLEND_MODES[fill.blendMode];
  return [blendMode ? {...result, blendMode} : result];
}

function strokeProperties(node) {
  if (!node.stroke) return {};
  const widths = node.strokeWidth;
  const independent = typeof widths === "object";
  const weight = independent ? Math.max(...Object.values(widths)) : widths ?? 1;
  const align = node.strokeAlignment === "inner" ? "INSIDE" : "CENTER";
  const cap = STROKE_CAPS[node.strokeLinecap];
  const join = STROKE_JOINS[node.strokeLinejoin];
  return {
    strokes:[{...solidPaint(node.stroke), weight, align, ...(cap ? {cap} : {}), ...(join ? {join} : {})}],
    strokeWeight:weight,
    strokeAlign:align,
    ...(cap ? {strokeCap:cap} : {}),
    ...(join ? {strokeJoin:join} : {}),
    ...(independent ? {
      independentStrokeWeights:true,
      borderTopWeight:widths.top, borderRightWeight:widths.right,
      borderBottomWeight:widths.bottom, borderLeftWeight:widths.left,
    } : {}),
  };
}

function cornerProperties(radius) {
  if (Array.isArray(radius)) {
    const [topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius] = radius;
    return {independentCorners:true, topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius};
  }
  return radius ? {cornerRadius:radius} : {};
}

function toEffects(effect) {
  if (!effect) return [];
  return (Array.isArray(effect) ? effect : [effect]).map((shadow) => ({
    type:shadow.shadowType === "inner" ? "INNER_SHADOW" : "DROP_SHADOW",
    visible:true, blendMode:"NORMAL", color:hexToColor(shadow.color),
    offset:shadow.offset, radius:shadow.blur, spread:shadow.spread,
  }));
}

function commonProperties(node) {
  return {
    name:node.name,
    x:node.x ?? 0,
    y:node.y ?? 0,
    ...(node.opacity !== undefined && node.opacity < 1 ? {opacity:node.opacity} : {}),
  };
}

function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1).map((t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  });
}

function networkBounds({vertices, segments}) {
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  for (const {start, end, tangentStart, tangentEnd} of segments) {
    const a = vertices[start];
    const b = vertices[end];
    xs.push(...cubicExtrema(a.x, a.x + tangentStart.x, b.x + tangentEnd.x, b.x));
    ys.push(...cubicExtrema(a.y, a.y + tangentStart.y, b.y + tangentEnd.y, b.y));
  }
  return {minX:Math.min(...xs), minY:Math.min(...ys), maxX:Math.max(...xs), maxY:Math.max(...ys)};
}

// The node's box is the path's own box, as in the editor: paint servers and selection both use it.
function vectorPlacement(node, hasFill) {
  const network = parseSVGPath(
    node.geometry,
    node.fillRule === "evenodd" ? "EVENODD" : "NONZERO",
    {includeOpenRegions:hasFill},
  );
  if (network.vertices.length === 0) return null;
  const [viewX = 0, viewY = 0, viewWidth = node.width, viewHeight = node.height] = node.viewBox || [];
  const uniform = viewWidth > 0 && viewHeight > 0 ? Math.min(node.width / viewWidth, node.height / viewHeight) : 1;
  const scaleX = node.stretchViewBox ? node.width / viewWidth : uniform;
  const scaleY = node.stretchViewBox ? node.height / viewHeight : uniform;
  const offsetX = (node.width - viewWidth * scaleX) / 2 - viewX * scaleX;
  const offsetY = (node.height - viewHeight * scaleY) / 2 - viewY * scaleY;
  for (const vertex of network.vertices) {
    vertex.x = vertex.x * scaleX + offsetX;
    vertex.y = vertex.y * scaleY + offsetY;
  }
  for (const segment of network.segments) {
    for (const tangent of [segment.tangentStart, segment.tangentEnd]) {
      tangent.x = round(tangent.x * scaleX);
      tangent.y = round(tangent.y * scaleY);
    }
  }
  const {minX, minY, maxX, maxY} = networkBounds(network);
  for (const vertex of network.vertices) {
    vertex.x = round(vertex.x - minX);
    vertex.y = round(vertex.y - minY);
  }
  return {
    x:round((node.x ?? 0) + minX),
    y:round((node.y ?? 0) + minY),
    width:round(maxX - minX),
    height:round(maxY - minY),
    vectorNetwork:network,
  };
}

// A run's rect is its inline box, while a text node's line box follows line-height; CSS centers
// one inside the other, so the layer starts above the rect when the line box is the taller one.
function textPlacement(node) {
  const {width, height, lineHeight} = node.measured;
  const singleLine = height <= lineHeight * 1.25;
  return {
    x:node.x ?? 0,
    y:round((node.y ?? 0) - (singleLine ? (lineHeight - height) / 2 : 0)),
    width,
    height:singleLine ? lineHeight : height,
  };
}

function textProperties(node) {
  return {
    ...textPlacement(node),
    text:node.content,
    fontFamily:node.fontFamily,
    fontSize:node.fontSize,
    fontWeight:Number(node.fontWeight) || 400,
    italic:node.fontStyle === "italic",
    lineHeight:node.measured.lineHeight,
    ...(node.letterSpacing ? {letterSpacing:node.letterSpacing} : {}),
    textAlignHorizontal:{center:"CENTER", right:"RIGHT"}[node.textAlign] || "LEFT",
    textAlignVertical:node.textAlignVertical === "middle" ? "CENTER" : "TOP",
    textAutoResize:node.textGrowth === "auto" ? "WIDTH_AND_HEIGHT" : "NONE",
  };
}

// Group boxes follow their children in the editor, so they cannot be taken from the source.
function fitGroup(group) {
  const {children} = group;
  const minX = Math.min(...children.map((child) => child.x));
  const minY = Math.min(...children.map((child) => child.y));
  const maxX = Math.max(...children.map((child) => child.x + child.width));
  const maxY = Math.max(...children.map((child) => child.y + child.height));
  for (const child of children) {
    child.x = round(child.x - minX);
    child.y = round(child.y - minY);
  }
  return {...group, x:round(group.x + minX), y:round(group.y + minY), width:round(maxX - minX), height:round(maxY - minY)};
}

export function toSceneNodes(root, imageHashes = new Map()) {
  let nextId = 0;
  const convertChildren = (node) => (node.children || []).map(convert).filter(Boolean);
  const convert = (node) => {
    const id = `capture:${nextId += 1}`;
    const common = {id, ...commonProperties(node)};
    if (node.type === "group") {
      const children = convertChildren(node);
      return children.length ? fitGroup({...common, type:"GROUP", children}) : null;
    }
    if (node.type === "text") {
      return {...common, type:"TEXT", ...textProperties(node), fills:toFills(node.fill, node.measured?.width ?? 0, node.measured?.height ?? 0, imageHashes)};
    }
    if (node.type === "path") {
      const hasFill = toFills(node.fill, 1, 1, imageHashes).length > 0;
      const placement = vectorPlacement(node, hasFill);
      if (!placement) return null;
      return {
        ...common, type:"VECTOR", ...placement,
        fills:toFills(node.fill, placement.width, placement.height, imageHashes),
        ...strokeProperties(node),
      };
    }
    const fills = toFills(node.fill, node.width, node.height, imageHashes);
    const imageFills = [node.fill].flat().filter((fill) => fill?.type === "image");
    const missingImage = imageFills.some((fill) => !imageHashes.get(fill.url));
    const painted = {
      ...common,
      ...(missingImage ? {name:`${node.name} · Image unavailable`} : {}),
      width:node.width,
      height:node.height,
      fills,
      ...strokeProperties(node),
      ...cornerProperties(node.cornerRadius),
      effects:toEffects(node.effect),
    };
    if (node.type === "rectangle") return {...painted, type:"RECTANGLE"};
    if (node.type === "ellipse") return {...painted, type:"ELLIPSE"};
    return {...painted, type:"FRAME", layoutMode:"NONE", clipsContent:Boolean(node.clip), children:convertChildren(node)};
  };
  return convert(root);
}

export function collectImageRequests(root) {
  const requests = new Map();
  const visit = (node) => {
    for (const fill of [node.fill].flat()) {
      if (fill?.type !== "image") continue;
      const previous = requests.get(fill.url);
      const shown = fill.imageRect || node;
      requests.set(fill.url, {
        width:Math.max(previous?.width ?? 0, shown.width ?? 0),
        height:Math.max(previous?.height ?? 0, shown.height ?? 0),
      });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return requests;
}
