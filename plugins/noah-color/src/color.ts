export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
export type Swatch = { name: string; hex: string };
const round = (value: number, places = 2) => Number(value.toFixed(places));
const pct = (value: number) => round(value * 100) + "%";

function fromHsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

function hue(value: string) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/.exec(value);
  if (!match) return NaN;
  const scales = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 };
  const degrees = Number(match[1]) * scales[(match[2] ?? "deg") as keyof typeof scales];
  return ((degrees % 360) + 360) % 360;
}

function component(value: string, scale: number, percentOnly = false) {
  if (!/^[+]?(?:\d+\.?\d*|\.\d+)%?$/.test(value) || (percentOnly && !value.endsWith("%"))) return NaN;
  return value.endsWith("%") ? Number(value.slice(0, -1)) * scale / 100 : Number(value);
}

export function parseColor(input: string): RGBA | undefined {
  const text = input.trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  const match = /^#?([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(text);
  if (match) {
    const expanded = match[1].length < 5 ? [...match[1]].map((digit) => digit.repeat(2)).join("") : match[1];
    const channels = expanded.match(/../g)!.map((pair) => parseInt(pair, 16));
    return [channels[0], channels[1], channels[2], channels[3] ?? 255];
  }
  const css = /^(rgba?|hsla?|hs[bv]|cmyk)\(\s*(.*?)\s*\)$/.exec(text);
  if (!css) return undefined;
  const items = css[2].split(/(?:\s*[,/]\s*|\s+)/);
  const kind = css[1];
  if (kind === "cmyk") {
    const [c, m, y, k] = items.map((item) => component(item, 1, true));
    if (items.length !== 4 || ![c, m, y, k].every((v) => v >= 0 && v <= 1)) return undefined;
    return [Math.round(255 * (1 - c) * (1 - k)), Math.round(255 * (1 - m) * (1 - k)), Math.round(255 * (1 - y) * (1 - k)), 255];
  }
  if (items.length < 3 || items.length > 4) return undefined;
  const alpha = component(items[3] ?? "1", 1);
  if (!(alpha >= 0 && alpha <= 1)) return undefined;
  if (kind.startsWith("rgb")) {
    const rgb = items.slice(0, 3).map((item) => component(item, 255));
    if (!rgb.every((v) => v >= 0 && v <= 255)) return undefined;
    return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), Math.round(alpha * 255)];
  }
  const h = hue(items[0]);
  const s = component(items[1], 1, true);
  const value = component(items[2], 1, true);
  if (!Number.isFinite(h) || ![s, value].every((v) => v >= 0 && v <= 1)) return undefined;
  const hsv = kind === "hsv" || kind === "hsb";
  const l = hsv ? value * (1 - s / 2) : value;
  const saturation = hsv ? (l === 0 || l === 1 ? 0 : (value - l) / Math.min(l, 1 - l)) : s;
  return [...fromHsl(h, saturation, l), Math.round(alpha * 255)];
}

export function toHex(rgb: RGB | RGBA) {
  return "#" + rgb.slice(0, rgb[3] === 255 ? 3 : 4).map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function hsl([red, green, blue]: RGB | RGBA) {
  const [r, g, b] = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  const sector = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const h = (sector * 60 + 360) % 360;
  return { h, l, s: delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1)), max, min };
}

function linear(channel: number) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function composite([r, g, b, a]: RGBA, under: RGB): RGB {
  return [r, g, b].map((channel, i) => channel * a / 255 + under[i] * (1 - a / 255)) as RGB;
}

export function contrastRatio(foreground: RGBA, background: RGBA) {
  const bg = composite(background, [255, 255, 255]);
  const values = [luminance(composite(foreground, bg)), luminance(bg)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function formats(color: RGBA) {
  const [r, g, b, alpha] = color;
  const { h, s, l, max, min } = hsl(color);
  const a = round(alpha / 255, 4);
  const cmyk = [r, g, b].map((channel) => pct(max === 0 ? 0 : 1 - channel / (255 * max)));
  const average = (r + g + b) / (3 * 255);
  const iHue = max === min ? 0 : (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI + 360) % 360;
  const [lr, lg, lb] = [r, g, b].map(linear);
  const xyz = [
    (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047,
    0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb,
    (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883,
  ];
  const [x, y, z] = xyz.map((v) => v > (6 / 29) ** 3 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29);
  return [
    { name: "HEX", hex: toHex(color) },
    { name: "RGB", hex: alpha === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})` },
    { name: "HSV / HSB", hex: `hsv(${round(h)}, ${pct(max === 0 ? 0 : 1 - min / max)}, ${pct(max)}${alpha < 255 ? ` / ${a}` : ""})` },
    { name: "HSL", hex: `hsl(${round(h)} ${pct(s)} ${pct(l)}${alpha < 255 ? ` / ${a}` : ""})` },
    { name: "CMYK", hex: `cmyk(${[...cmyk, pct(1 - max)].join(", ")})` },
    { name: "HSI", hex: `${round(iHue)}°, ${pct(average ? 1 - min / average : 0)}, ${pct(average)}` },
    { name: "CIE Lab · D65", hex: [116 * y - 16, 500 * (x - y), 200 * (y - z)].map((v) => round(v, 3)).join(", ") },
  ];
}

export function harmony(color: RGBA) {
  const { h, s, l } = hsl(color);
  const rows: [string, number][] = [
    ["互补色", 180], ["类似色 1", -30], ["类似色 2", 30],
    ["分裂互补色 1", 150], ["分裂互补色 2", 210],
    ["三角色 1", 120], ["三角色 2", 240],
  ];
  return rows.map(([name, offset]) => ({ name, hex: toHex([...fromHsl((h + offset + 360) % 360, s, l), color[3]]) }));
}

export function parseList(text: string, max = 12): RGBA[] {
  const tokens = text.match(/[a-z]+\([^()]*\)|[^,;\s，；]+/gi) ?? [];
  const colors = tokens.map(parseColor);
  if (colors.length < 2 || colors.length > max || colors.some((color) => !color)) {
    throw new Error(`请输入 2–${max} 个有效颜色，用空格、逗号或换行分隔。`);
  }
  return colors as RGBA[];
}
