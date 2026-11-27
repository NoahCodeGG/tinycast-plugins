import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RemoteProgress = { autoSync?: boolean; syncedStamp?: string; syncState?: "syncing" | "failed" };
export type WebDav = RemoteProgress & { url: string; authorization?: string; etag?: string };
export type CancelRegistration = (stop: () => void) => boolean;

const databaseLimit = 128 * 1024 * 1024;

export function webDavConnection(address: string, username: string, secret: string): WebDav {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error("请输入完整的 HTTPS WebDAV 文件地址。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || username.includes(":")) {
    throw new Error("请输入 HTTPS 文件地址，并在单独的字段中填写 WebDAV 凭据。");
  }
  return {
    url: url.href,
    authorization: username || secret
      ? "Basic " + Buffer.from(username + ":" + secret, "utf8").toString("base64")
      : undefined,
  };
}

function quote(value: string) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
}

export type TransferRequest = {
  url: string;
  authorization?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  upload?: string;
};

export function transfer(
  connection: TransferRequest, output: string, headers: string, register: CancelRegistration,
): Promise<number> {
  const options = [
    "silent", "globoff", 'proto = "=https"', "connect-timeout = 10", "max-time = 30",
    `max-filesize = ${databaseLimit}`, 'write-out = "%{http_code}"',
    "url = " + quote(connection.url), "output = " + quote(output), "dump-header = " + quote(headers),
  ];
  if (connection.authorization) options.push("header = " + quote("Authorization: " + connection.authorization));
  if (connection.method) options.push("request = " + quote(connection.method));
  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    if (!/^[a-zA-Z0-9-]+$/.test(name) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("远端请求头无效。");
    options.push("header = " + quote(name + ": " + value));
  }
  if (connection.upload) options.push("upload-file = " + quote(connection.upload));
  const curl = spawn("/usr/bin/curl", ["-q", "--config", "-"], { stdio: ["pipe", "pipe", "pipe"], timeout: 32_000 });
  return new Promise((resolve, reject) => {
    let result = "";
    const failure = () => reject(new Error("云端连接失败。请检查地址、证书及网络。"));
    curl.stderr.resume();
    curl.on("error", failure);
    curl.stdin.on("error", failure);
    curl.stdout.on("data", (chunk: Buffer) => { result += chunk.toString("ascii"); });
    curl.on("close", (code) => code === 0 && /^\d{3}$/.test(result) ? resolve(Number(result)) : failure());
    if (!register(() => { curl.kill(); })) {
      curl.kill();
      reject(new Error("操作已取消。"));
      return;
    }
    curl.stdin.end(options.join("\n") + "\n");
  });
}

export async function responseHeader(headers: string, name: string) {
  const last = (await readFile(headers, "utf8")).trim().split(/\r?\n\r?\n/).at(-1) ?? "";
  return last.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(name.toLowerCase() + ":"))?.slice(name.length + 1).trim();
}

export class RemoteConflict extends Error {
  constructor() {
    super("远端密码库已变化或同名文件已存在。本地版本已保留。");
  }
}

function checkStatus(status: number) {
  if (status >= 200 && status < 300) return;
  if (status === 412 || status === 409) throw new RemoteConflict();
  if (status === 401 || status === 403) throw new Error("WebDAV 拒绝访问。请检查账户和文件权限。");
  throw new Error(`WebDAV 请求失败（HTTP ${status}）。`);
}

async function readEtag(headers: string) {
  const etag = await responseHeader(headers, "ETag");
  return etag && /^"[^"\x00-\x1f\x7f]*"$/.test(etag) ? etag : undefined;
}

export async function downloadWebDav(connection: WebDav, destination: string, register: CancelRegistration) {
  const folder = await mkdtemp(join(destination, "Tinycast-WebDAV-"));
  const encoded = new URL(connection.url).pathname.split("/").at(-1) ?? "";
  let name = "WebDAV.kdbx";
  try {
    const filename = decodeURIComponent(encoded).replace(/[/\x00-\x1f:]/g, "_").trim();
    if (filename.length > 5 && filename.length <= 120 && filename.toLowerCase().endsWith(".kdbx")) name = filename;
  } catch {
    // Malformed URL escaping does not determine the local filename.
  }
  const file = join(folder, name);
  const headers = join(folder, "headers");
  let downloaded = false;
  try {
    const status = await transfer(connection, file, headers, register);
    checkStatus(status);
    if (status !== 200) throw new Error("WebDAV 未返回完整的密码库。");
    await chmod(file, 0o600);
    connection.etag = await readEtag(headers);
    downloaded = true;
    return file;
  } catch (failure) {
    await unlink(file).catch(() => {});
    throw failure;
  } finally {
    await unlink(headers).catch(() => {});
    if (!downloaded) await rmdir(folder).catch(() => {});
  }
}

export async function uploadWebDav(connection: WebDav, path: string, register: CancelRegistration, checkSource: () => Promise<void>, create = false) {
  const folder = await mkdtemp(join(tmpdir(), "tinycast-webdav-upload-"));
  const snapshot = join(folder, "vault.kdbx");
  const headers = join(folder, "headers");
  try {
    await checkSource();
    await copyFile(path, snapshot);
    await checkSource();
    if (!create && !connection.etag) throw new Error("服务器未提供可用于冲突检测的版本标识，请重新下载远端库。");
    const condition: Record<string, string> = create ? { "If-None-Match": "*" } : { "If-Match": connection.etag! };
    checkStatus(await transfer({ ...connection, upload: snapshot, headers: condition }, "/dev/null", headers, register));
    connection.etag = await readEtag(headers);
  } finally {
    await unlink(headers).catch(() => {});
    await unlink(snapshot).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}
