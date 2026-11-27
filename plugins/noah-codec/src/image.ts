import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBase64 } from "./base64";
import { readChunks } from "./files";

const maximumBytes = 8 * 1024 * 1024;

function formatOf(bytes: Uint8Array) {
  const signature = Buffer.from(bytes.subarray(0, 12)).toString("hex");
  if (signature.startsWith("89504e470d0a1a0a")) return { extension: "png", mime: "image/png" };
  if (signature.startsWith("ffd8ff")) return { extension: "jpg", mime: "image/jpeg" };
  if (signature.startsWith("474946383761") || signature.startsWith("474946383961")) {
    return { extension: "gif", mime: "image/gif" };
  }
  if (signature.startsWith("52494646") && signature.slice(16, 24) === "57454250") {
    return { extension: "webp", mime: "image/webp" };
  }
  if (signature.startsWith("424d")) return { extension: "bmp", mime: "image/bmp" };
  if (signature.startsWith("49492a00") || signature.startsWith("4d4d002a")) {
    return { extension: "tiff", mime: "image/tiff" };
  }
  throw new Error("无法识别图片格式。支持 PNG、JPEG、GIF、WebP、BMP 和 TIFF。");
}

export async function encodeImage(path: string) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await readChunks(path, (chunk) => {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("图片超过 8 MiB。");
    chunks.push(chunk.slice());
  });
  const buffer = Buffer.concat(chunks, size);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { mime } = formatOf(bytes);
  const data = buffer.toString("base64");
  return { data, uri: "data:" + mime + ";base64," + data };
}

export async function saveImage(input: string, destination: string) {
  const text = input.trim();
  const uri = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(text);
  const bytes = decodeBase64(text.slice(uri?.[0].length ?? 0), maximumBytes);
  const { mime, extension } = formatOf(bytes);
  if (uri && uri[1].toLowerCase() !== mime) {
    throw new Error("Data URI 声明的类型与图片实际格式不符。");
  }
  const folder = join(destination, "tinycast-image-" + randomUUID().slice(0, 13).toLowerCase());
  await mkdir(folder);
  const file = join(folder, "image." + extension);
  try {
    await writeFile(file, bytes);
    return file;
  } catch (error) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
