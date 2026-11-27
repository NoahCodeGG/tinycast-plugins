import { closeSync, openSync, readSync, statSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { md5, sha1 } from "@noble/hashes/legacy";
import { sha224, sha256 } from "@noble/hashes/sha256";
import { sha384, sha512 } from "@noble/hashes/sha512";
import { bytesToHex } from "@noble/hashes/utils";
import type { Result } from "./ui";

const algorithms = { MD5: md5, "SHA-1": sha1, "SHA-224": sha224, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 };

export function textHashes(input: string): Result[] {
  const bytes = new TextEncoder().encode(input);
  return Object.entries(algorithms).map(([label, hash]) => ({ label, value: bytesToHex(hash(bytes)) }));
}

export async function readChunks(path: string, onChunk: (chunk: Uint8Array) => void) {
  const initial = statSync(path);
  if (!initial.isFile()) throw new Error("请选择一个普通文件。");

  const fd = openSync(path, "r");
  const buffer = new Uint8Array(256 * 1024);
  let position = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      onChunk(buffer.subarray(0, count));
      position += count;
      if (position % (buffer.length * 4) === 0) await wait(0);
    }
  } finally {
    closeSync(fd);
  }
  const current = statSync(path);
  if (position !== initial.size || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) {
    throw new Error("读取时文件已更改，请重试。");
  }
}

export async function fileHashes(path: string): Promise<Result[]> {
  const hashes = Object.entries(algorithms).map(([label, create]) => ({ label, hash: create.create() }));
  await readChunks(path, (chunk) => {
    for (const { hash } of hashes) hash.update(chunk);
  });
  return hashes.map(({ label, hash }) => ({ label, value: bytesToHex(hash.digest()) }));
}
