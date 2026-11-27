import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { toHex, type RGBA, type Swatch } from "./color";

const exec = promisify(execFile);

export function cardPng(colors: RGBA[]) {
  const png = new PNG({ width: 480, height: 128 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      png.data.set(colors[Math.floor(x * colors.length / png.width)], (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

export function gradientPng(colors: RGBA[], angle: number, width: number, height: number) {
  const png = new PNG({ width, height });
  const radians = angle * Math.PI / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const span = Math.abs(dx) * (width - 1) + Math.abs(dy) * (height - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const projection = (x - (width - 1) / 2) * dx + (y - (height - 1) / 2) * dy;
      const position = Math.max(0, Math.min(1, span > 1e-9 ? 0.5 + projection / span : 0.5)) * (colors.length - 1);
      const start = Math.min(Math.floor(position), colors.length - 2);
      const mix = position - start;
      const [a, b] = [colors[start], colors[start + 1]];
      const left = a[3] * (1 - mix);
      const right = b[3] * mix;
      const alpha = left + right;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        png.data[index + channel] = alpha ? Math.round((a[channel] * left + b[channel] * right) / alpha) : 0;
      }
      png.data[index + 3] = Math.round(alpha);
    }
  }
  return PNG.sync.write(png);
}

export function prepareAiCard(data: Buffer, colors: RGBA[]) {
  if (data.length < 33 || data.toString("ascii", 12, 16) !== "IHDR") throw new Error("无法解码模型返回的 PNG。");
  const expectedWidth = data.readUInt32BE(16);
  const expectedHeight = data.readUInt32BE(20);
  if (![expectedWidth, expectedHeight].every((value) => value >= 1 && value <= 2048)) {
    throw new Error("模型返回的 PNG 尺寸超出范围。");
  }
  let image: PNG;
  try {
    image = PNG.sync.read(data);
  } catch {
    throw new Error("模型返回的 PNG 无法打开。");
  }
  const { width, height } = image;
  const bandHeight = Math.max(1, Math.round(height * 0.1));
  const card = new PNG({ width, height: height + bandHeight });
  card.data.set(image.data);
  for (let y = height; y < card.height; y++) {
    for (let x = 0; x < width; x++) {
      card.data.set(colors[Math.floor(x * colors.length / width)], (y * width + x) * 4);
    }
  }
  const scale = Math.min(1, 288 / Math.max(card.width, card.height));
  const preview = new PNG({ width: Math.max(1, Math.round(card.width * scale)), height: Math.max(1, Math.round(card.height * scale)) });
  for (let y = 0; y < preview.height; y++) {
    for (let x = 0; x < preview.width; x++) {
      const offset = (Math.floor(y * card.height / preview.height) * card.width + Math.floor(x * card.width / preview.width)) * 4;
      preview.data.set(card.data.subarray(offset, offset + 4), (y * preview.width + x) * 4);
    }
  }
  return { png: PNG.sync.write(card), preview: PNG.sync.write(preview) };
}

export const pngMarkdown = (png: Buffer) => `![](data:image/png;base64,${png.toString("base64")})`;

export function extractSwatches(data: Buffer, count: number): Swatch[] {
  // The native decoder returns premultiplied RGBA. Group pixels in 5-bit RGB buckets
  // and merge nearby buckets so slightly different shades do not fill the result.
  type Bucket = { weight: number; r: number; g: number; b: number };
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 24) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]].map((v) => Math.min(255, Math.round(v * 255 / alpha)));
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key) ?? { weight: 0, r: 0, g: 0, b: 0 };
    bucket.weight += alpha;
    bucket.r += r * alpha;
    bucket.g += g * alpha;
    bucket.b += b * alpha;
    buckets.set(key, bucket);
  }
  const candidates = [...buckets.values()].sort((a, b) => b.weight - a.weight);
  const distance = (a: Bucket, b: Bucket) =>
    (a.r / a.weight - b.r / b.weight) ** 2 +
    (a.g / a.weight - b.g / b.weight) ** 2 +
    (a.b / a.weight - b.b / b.weight) ** 2;
  const selected: Bucket[] = [];
  for (const candidate of candidates) {
    const close = selected.find((entry) => distance(candidate, entry) <= 32 ** 2);
    if (close) {
      close.weight += candidate.weight;
      close.r += candidate.r;
      close.g += candidate.g;
      close.b += candidate.b;
    } else {
      selected.push(candidate);
    }
  }
  return selected.sort((a, b) => b.weight - a.weight).slice(0, count).map((bucket, i) => ({
    name: `主色 ${i + 1}`,
    hex: toHex([bucket.r, bucket.g, bucket.b].map((v) => Math.round(v / bucket.weight)) as [number, number, number]),
  }));
}

export async function readImagePalette(helper: string, path: string | undefined, count: number) {
  let stdout: Buffer;
  try {
    ({ stdout } = await exec(helper, path === undefined ? ["clipboard"] : ["pixels", path], { encoding: "buffer", timeout: 12_000, maxBuffer: 64 * 1024 }));
  } catch {
    throw new Error(path === undefined ? "剪贴板中没有可读取的图片。" : "无法读取图片。请选择 macOS 可打开的图片文件。");
  }
  const header = stdout.indexOf(10);
  const [width, height] = stdout.subarray(0, header).toString().split(" ").map(Number);
  const pixels = stdout.subarray(header + 1);
  if (header < 0 || !width || !height || pixels.length !== width * height * 4) throw new Error("无法解码图片。");
  const colors = extractSwatches(pixels, count);
  if (!colors.length) throw new Error("图片没有可用于提取的可见颜色。");
  return colors;
}

export function savePng(folder: string, filename: string, png: Buffer) {
  return writeFile(join(folder, filename), Uint8Array.from(png), { flag: "wx" });
}

let clipboardFolder: string | undefined;
export async function stageClipboardPng(png: Buffer, copy: (path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "tinycast-color-"));
  const path = join(folder, "色卡.png");
  try {
    await writeFile(path, Uint8Array.from(png), { mode: 0o600 });
    await copy(path);
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const previous = clipboardFolder;
  clipboardFolder = folder;
  if (previous) await rm(previous, { recursive: true, force: true }).catch(() => {});
}
