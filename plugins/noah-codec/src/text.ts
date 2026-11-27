import { Buffer } from "node:buffer";
import { decodeHTMLStrict, escapeUTF8 } from "entities";
import { parseTimestamp } from "../../../packages/conversions/timestamp";
import { convertUrl } from "../../../packages/conversions/url";
import { decodeBase64, decodeUtf8 } from "./base64";
import { formatTimeInZone, formatYear, timeZoneTitle, twoDigits } from "./time-zones";
import type { Result } from "./ui";

function attempt(label: string, run: () => string): Result {
  try {
    return { label, value: run() };
  } catch (error) {
    return { label, error: error instanceof Error ? error.message : String(error) };
  }
}

export function base64Results(input: string): Result[] {
  const bytes = Buffer.from(input, "utf8");
  const encoded = bytes.toString("base64");
  return [
    { label: "Base64 编码", value: encoded },
    { label: "Base64URL 编码", value: encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") },
    attempt("Base64 解码", () => decodeUtf8(decodeBase64(input))),
  ];
}

export function urlResults(input: string): Result[] {
  const encoded = convertUrl(input, encodeURIComponent);
  const decoded = convertUrl(input, decodeURIComponent);
  return [
    encoded === undefined ? { label: "URL 编码", error: "输入含有不成对的代理项。" } : { label: "URL 编码", value: encoded },
    decoded === undefined ? { label: "URL 解码", error: "百分号编码或 UTF-8 无效。" } : { label: "URL 解码", value: decoded },
  ];
}

function localDate(input: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(input.trim());
  if (!match) return;
  const utc = parseTimestamp(match[1] + "T" + match[2] + "Z");
  if (!utc) return;
  const date = new Date(match[1] + "T" + match[2]);
  if (!Number.isFinite(date.getTime())) return;
  // Reject wall times skipped when local daylight saving time starts.
  const wallTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  if (wallTime.getTime() === utc.getTime()) return date;
}

export function timestampResults(input: string, zones: readonly string[] = []): Result[] {
  const date = input.trim() ? parseTimestamp(input) ?? localDate(input) : new Date();
  if (!date) throw new Error("请输入 Unix 时间戳、ISO 8601 日期或本地时间。");
  const localDay = [formatYear(date.getFullYear()), twoDigits(date.getMonth() + 1), twoDigits(date.getDate())].join("-");
  const localClock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(":");
  return [
    { label: "本地时间", value: localDay + " " + localClock },
    { label: "本地日期", value: localDay },
    { label: "Unix 秒", value: String(Math.floor(date.getTime() / 1000)) },
    { label: "Unix 毫秒", value: String(date.getTime()) },
    { label: "UTC · ISO 8601", value: date.toISOString() },
    ...zones.map((zone) => attempt(timeZoneTitle(zone), () => formatTimeInZone(date, zone))),
  ];
}

const radices = [
  { label: "二进制", base: 2, prefix: "0b", digits: /^[01]+$/i },
  { label: "八进制", base: 8, prefix: "0o", digits: /^[0-7]+$/i },
  { label: "十进制", base: 10, prefix: "", digits: /^\d+$/i },
  { label: "十六进制", base: 16, prefix: "0x", digits: /^[\da-f]+$/i },
];

export function radixResults(input: string): Result[] {
  const match = /^([+-]?)(0[bBoOxX])?([\da-f]+)$/i.exec(input.trim());
  const radix = match && radices.find(({ prefix }) => prefix === (match[2]?.toLowerCase() ?? ""));
  if (!match || !radix?.digits.test(match[3])) {
    throw new Error("请输入整数。二、八、十六进制分别使用 0b、0o、0x 前缀。");
  }
  const absolute = BigInt(radix.prefix + match[3]);
  const sign = match[1] === "-" && absolute !== 0n ? "-" : "";
  return radices.map(({ label, prefix, base }) => ({ label, value: sign + prefix + absolute.toString(base) }));
}

export function decodeUnicode(input: string): string | undefined {
  const tokens = input.trim().split(/\s+/).join("");
  if (/^(?:\\x[\da-f]{2})+$/i.test(tokens)) {
    const bytes = tokens.match(/[\da-f]{2}(?=\\|$)/gi) ?? [];
    return decodeUtf8(Uint8Array.from(bytes, (byte) => parseInt(byte, 16)));
  }
  if (/^(?:(?:U\+[\da-f]{1,6})|(?:\\u\{[\da-f]{1,6}\}))+$/i.test(tokens)) {
    return (tokens.match(/[\da-f]{1,6}/gi) ?? []).map((hex) => {
      const point = parseInt(hex, 16);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error("Unicode 码位无效。");
      return String.fromCodePoint(point);
    }).join("");
  }
  if (/^(?:\\u[\da-f]{4})+$/i.test(tokens)) {
    const text = tokens.replace(/\\u([\da-f]{4})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    for (const point of text) {
      const unit = point.charCodeAt(0);
      if (point.length === 1 && unit >= 0xd800 && unit <= 0xdfff) throw new Error("UTF-16 含有不成对的代理项。");
    }
    return text;
  }
}

export function unicodeResults(input: string): Result[] {
  const hex = (value: number, width: number) => value.toString(16).toUpperCase().padStart(width, "0");
  const entities = decodeHTMLStrict(input);
  const results: Result[] = [
    { label: "Unicode 码位", value: Array.from(input, (point) => "U+" + hex(point.codePointAt(0)!, 4)).join(" ") },
    { label: "UTF-8 字节", value: Array.from(new TextEncoder().encode(input), (byte) => "\\x" + hex(byte, 2)).join("") },
    { label: "UTF-16 转义", value: input.split("").map((unit) => "\\u" + hex(unit.charCodeAt(0), 4)).join("") },
    { label: "HTML 转义", value: escapeUTF8(input) },
    { label: "HTML 数字实体", value: Array.from(input, (point) => "&#x" + hex(point.codePointAt(0)!, 1) + ";").join("") },
  ];
  if (entities !== input) results.unshift({ label: "HTML 实体解码", value: entities });
  try {
    const decoded = decodeUnicode(input);
    if (decoded !== undefined) results.unshift({ label: "Unicode 解码", value: decoded });
  } catch (error) {
    results.unshift({ label: "Unicode 解码", error: error instanceof Error ? error.message : String(error) });
  }
  return results;
}
