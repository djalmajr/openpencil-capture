import { clamp, px } from "./css-values.mjs";

export function channelToHex(value) {
  return Math.round(clamp(value) * 255).toString(16).padStart(2, "0").toUpperCase();
}

function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

const srgbToLinear = (value) => Math.sign(value) * (Math.abs(value) <= 0.04045 ? Math.abs(value) / 12.92 : ((Math.abs(value) + 0.055) / 1.055) ** 2.4);
const multiply = (matrix, [x, y, z]) => matrix.map(([a, b, c]) => a * x + b * y + c * z);

const XYZ_D65_TO_LINEAR_SRGB = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];
const XYZ_D50_TO_D65 = [[0.9555766, -0.0230393, 0.0631636], [-0.0282895, 1.0099416, 0.0210077], [0.0122982, -0.020483, 1.3299098]];
const LINEAR_SRGB_TO_XYZ_D65 = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];

function hexFromLinearSrgb([red, green, blue], alpha = 1) {
  const hex = `#${channelToHex(linearToSrgb(red))}${channelToHex(linearToSrgb(green))}${channelToHex(linearToSrgb(blue))}`;
  return alpha < 1 ? `${hex}${channelToHex(alpha)}` : hex;
}

const hexFromXyzD65 = (xyz, alpha) => hexFromLinearSrgb(multiply(XYZ_D65_TO_LINEAR_SRGB, xyz), alpha);

function oklabToHex(lightness, a, b, alpha = 1) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return hexFromLinearSrgb([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ], alpha);
}

function labToHex(lightness, a, b, alpha = 1) {
  const delta = 6/29;
  const inverse = (value) => value > delta ? value**3 : 3*delta**2*(value-4/29);
  const fy = (lightness+16)/116;
  const xyzD50 = [0.96422*inverse(fy+a/500), inverse(fy), 0.82521*inverse(fy-b/200)];
  return hexFromXyzD65(multiply(XYZ_D50_TO_D65, xyzD50), alpha);
}

// `color()` spaces, each as its transfer function and its matrix to XYZ D65.
const rec2020ToLinear = (value) => {
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  const magnitude = Math.abs(value);
  return Math.sign(value) * (magnitude < beta * 4.5 ? magnitude / 4.5 : ((magnitude + alpha - 1) / alpha) ** (1 / 0.45));
};
const PREDEFINED_SPACES = {
  "srgb":{linear:srgbToLinear, toXyz:LINEAR_SRGB_TO_XYZ_D65},
  "srgb-linear":{linear:(value) => value, toXyz:LINEAR_SRGB_TO_XYZ_D65},
  "display-p3":{linear:srgbToLinear, toXyz:[[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]]},
  "rec2020":{linear:rec2020ToLinear, toXyz:[[0.6369580483012914, 0.14461690358620832, 0.1688809751641721], [0.2627002120112671, 0.6779980715188708, 0.05930171646986196], [0, 0.028072693049087428, 1.060985057710791]]},
  "a98-rgb":{linear:(value) => Math.sign(value) * Math.abs(value) ** (563 / 256), toXyz:[[0.5766690429101305, 0.1855582379065463, 0.1882286462349947], [0.29734497525053605, 0.6273635662554661, 0.07529145849399788], [0.02703136138641234, 0.07068885253582723, 0.9913375368376388]]},
  "prophoto-rgb":{linear:(value) => Math.sign(value) * (Math.abs(value) <= 16 / 512 ? Math.abs(value) / 16 : Math.abs(value) ** 1.8), toXyz:XYZ_D50_TO_D65, fromD50:[[0.7977604896723027, 0.13518583717574031, 0.0313493495815248], [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902], [0, 0, 0.8251046025104601]]},
  "xyz":{linear:(value) => value, toXyz:[[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
  "xyz-d65":{linear:(value) => value, toXyz:[[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
  "xyz-d50":{linear:(value) => value, toXyz:XYZ_D50_TO_D65},
};

function predefinedToHex(space, channels, alpha) {
  const definition = PREDEFINED_SPACES[space];
  if (!definition) return undefined;
  const linear = channels.map(definition.linear);
  const xyz = definition.fromD50 ? multiply(definition.fromD50, linear) : linear;
  return hexFromXyzD65(multiply(definition.toXyz, xyz), alpha);
}

function parseAlpha(value) {
  if (value == null || value === "none") return value === "none" ? 0 : 1;
  const number = Number.parseFloat(value);
  return value.includes("%") ? number / 100 : number;
}

// A computed color's channels are numbers, `none` (zero) or, for `color()`, percentages of one.
function channel(value, percentOf = 1) {
  if (value === "none") return 0;
  const number = Number.parseFloat(value);
  return value.endsWith("%") ? number / 100 * percentOf : number;
}

export function cssColorToHex(value) {
  if (!value || value === "transparent" || value === "none") return null;
  if (value.startsWith("#")) return value.toUpperCase();
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i);
  if (rgb) {
    const alpha = parseAlpha(rgb[4]);
    if (alpha === 0) return null;
    const hex = `#${channelToHex(Number(rgb[1]) / 255)}${channelToHex(Number(rgb[2]) / 255)}${channelToHex(Number(rgb[3]) / 255)}`;
    return alpha < 1 ? `${hex}${channelToHex(alpha)}` : hex;
  }
  const functional = value.match(/^(oklch|oklab|lch|lab|color)\(\s*(.*?)\s*\)$/i);
  if (functional) {
    const [components, alphaText] = functional[2].split("/").map((part) => part.trim());
    const parts = components.split(/\s+/);
    const alpha = parseAlpha(alphaText);
    if (alpha === 0) return null;
    const name = functional[1].toLowerCase();
    if (name === "color") {
      const hex = predefinedToHex(parts[0].toLowerCase(), parts.slice(1, 4).map((part) => channel(part)), alpha);
      if (hex) return hex;
    } else if (parts.length === 3) {
      const [first, second, third] = parts;
      if (name === "oklab") return oklabToHex(channel(first), channel(second, 0.4), channel(third, 0.4), alpha);
      if (name === "lab") return labToHex(channel(first, 100), channel(second, 125), channel(third, 125), alpha);
      const hue = channel(third) * Math.PI / 180;
      if (name === "oklch") {
        const chroma = channel(second, 0.4);
        return oklabToHex(channel(first), chroma * Math.cos(hue), chroma * Math.sin(hue), alpha);
      }
      const chroma = channel(second, 150);
      return labToHex(channel(first, 100), chroma * Math.cos(hue), chroma * Math.sin(hue), alpha);
    }
  }
  throw new Error(`Unsupported CSS color: ${value}`);
}

export function safeColor(value) {
  try { return cssColorToHex(value); } catch { return null; }
}

export function colorWithOpacity(color, opacity) {
  if (!color) return null;
  const alpha = clamp(px(opacity, 1));
  if (alpha >= 1) return color;
  const base = color.length === 9 ? color.slice(0, 7) : color;
  return `${base}${channelToHex(alpha)}`;
}

export function colorWithCombinedOpacity(color, ...opacities) {
  if (!color) return null;
  const expanded = color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color.length === 5
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}${color[4]}${color[4]}`
      : color;
  const sourceAlpha = expanded.length === 9 ? Number.parseInt(expanded.slice(7), 16) / 255 : 1;
  const alpha = opacities.reduce((value, opacity) => value * clamp(px(opacity, 1)), sourceAlpha);
  return `${expanded.slice(0, 7)}${channelToHex(alpha)}`;
}

export function gradientColor(value) {
  if (value === "transparent") return "#00000000";
  const alpha = value.match(/^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+\s*[,/]\s*([\d.]+)%?\s*\)$/i)?.[1];
  return alpha !== undefined && Number(alpha) === 0 ? "#00000000" : safeColor(value);
}
