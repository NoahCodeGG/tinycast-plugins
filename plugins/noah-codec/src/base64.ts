import { Buffer } from "node:buffer";

export function decodeBase64(input: string, maxBytes = Infinity): Uint8Array {
  const compact = input.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : Number(compact.endsWith("="));
  const data = compact.slice(0, compact.length - padding);
  const remainder = data.length % 4;
  if (
    !data || /[^A-Za-z0-9+/_-]/.test(data) || (/[+/]/.test(data) && /[-_]/.test(data))
    || remainder === 1 || (padding > 0 && compact.length % 4 !== 0)
  ) {
    throw new Error("请输入有效的 Base64 或 Base64URL。");
  }
  if (Math.floor(data.length * 3 / 4) > maxBytes) throw new Error("图片超过 8 MiB。");

  const canonical = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(canonical, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== canonical) {
    throw new Error("Base64 的末尾位无效。");
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("解码后的内容不是有效的 UTF-8 文本。");
  }
}
