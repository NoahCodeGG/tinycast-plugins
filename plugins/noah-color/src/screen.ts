import { environment, getPreferenceValues, LocalStorage } from "@raycast/api";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { formats, parseColor, toHex } from "./color";

const exec = promisify(execFile);
const recentKey = "recent-screen-colors-v1";
const recentLimit = 50;
let picking = false;

export async function sampleScreen() {
  if (picking) return undefined;
  picking = true;
  try {
    const helper = join(environment.assetsPath, "color-helper");
    const { stdout } = await exec(helper, ["sample"], { timeout: 120_000 });
    const hex = stdout.trim();
    if (!hex) return undefined;
    if (!/^#[0-9A-F]{6}$/i.test(hex)) throw new Error("无法读取屏幕色值。");
    return hex.toUpperCase();
  } finally {
    picking = false;
  }
}

export async function readRecentColors(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(recentKey);
  if (!raw) return [];
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    const valid = items
      .filter((item): item is string => typeof item === "string" && /^#[0-9A-F]{6}$/i.test(item))
      .map((hex) => hex.toUpperCase());
    return [...new Set(valid)].slice(0, recentLimit);
  } catch {
    return [];
  }
}

export async function rememberScreenColor(hex: string) {
  const items = await readRecentColors();
  const updated = [hex, ...items.filter((value) => value !== hex)].slice(0, recentLimit);
  await LocalStorage.setItem(recentKey, JSON.stringify(updated));
}

export function preferredColor(hex: string) {
  const { screenColorFormat } = getPreferenceValues<{ screenColorFormat?: string }>();
  const rgba = parseColor(hex);
  if (!rgba) return hex;
  if (screenColorFormat === "hex-lowercase") return toHex(rgba).toLowerCase();
  return formats(rgba).find(({ name }) => name === screenColorFormat)?.hex ?? toHex(rgba);
}
