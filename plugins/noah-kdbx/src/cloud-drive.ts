import { chmod, copyFile, mkdtemp, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { authorizationHeader, type CloudAuth } from "./cloud-oauth";
import { RemoteConflict, responseHeader, transfer, type CancelRegistration, type RemoteProgress, type TransferRequest } from "./webdav";

export type CloudDrive = RemoteProgress & { auth: CloudAuth; remote: string; revision?: string; item?: string };
type FileMetadata = { id?: string; name?: string; eTag?: string; headRevisionId?: string; "@microsoft.graph.downloadUrl"?: string };
const googleFiles = "https://www.googleapis.com/drive/v3/files";
const googleUploads = "https://www.googleapis.com/upload/drive/v3/files";
const graph = "https://graph.microsoft.com/v1.0";

function asciiJson(value: unknown) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function safeName(name: string) {
  const filename = name.replace(/[/\\:\x00-\x1f]/g, "_").trim();
  return filename.length > 5 && filename.length <= 120 && filename.toLowerCase().endsWith(".kdbx")
    ? filename
    : "Cloud.kdbx";
}

export function remoteResource(provider: CloudAuth["provider"], input: string, create = false) {
  const remote = input.trim();
  if (provider === "google" && !create) {
    const match = remote.match(/^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/);
    const id = match?.[1] ?? remote;
    if (/^[a-zA-Z0-9_-]{3,256}$/.test(id)) return id;
    throw new Error("请输入 Google Drive 文件 ID 或文件链接。");
  }
  if (provider === "google") {
    if (safeName(remote) !== remote || remote.length <= 5) throw new Error("请输入有效的 .kdbx 文件名。");
    return remote;
  }
  if (!remote.startsWith("/") || !remote.toLowerCase().endsWith(".kdbx") || remote.length > 2000
    || remote.slice(1).split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(remote)) {
    throw new Error("请输入以 / 开头的远端 .kdbx 路径。");
  }
  if (provider === "teams" && !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\//i.test(remote)) {
    throw new Error("请输入 /团队 ID/文件夹/密码库.kdbx。");
  }
  return remote;
}

function checkStatus(status: number) {
  if (status >= 200 && status < 300) return;
  if (status === 409 || status === 412) throw new RemoteConflict();
  if (status === 401 || status === 403) throw new Error("云端访问被拒绝。请核对应用权限和账号。");
  throw new Error(`云端请求失败（HTTP ${status}）。`);
}

function strongTag(tag: string | null | undefined) {
  return tag && /^"[^"\x00-\x1f\x7f]+"$/.test(tag) ? tag : undefined;
}

async function metadata(url: string, authorization: string) {
  const response = await fetch(url, { headers: { Authorization: authorization } });
  checkStatus(response.status);
  return {
    info: await response.json() as FileMetadata,
    etag: strongTag(response.headers.get("ETag")),
  };
}

function graphFile(connection: CloudDrive, byId = false) {
  const parts = connection.remote.slice(1).split("/");
  const drive = connection.auth.provider === "teams" ? "/groups/" + encodeURIComponent(parts.shift()!) + "/drive" : "/me/drive";
  if (byId && connection.item) return graph + drive + "/items/" + encodeURIComponent(connection.item);
  return graph + drive + "/root:/" + parts.map(encodeURIComponent).join("/");
}

function googleMetadata(connection: CloudDrive, authorization: string) {
  return metadata(googleFiles + "/" + encodeURIComponent(connection.remote) + "?fields=name,headRevisionId&supportsAllDrives=true", authorization);
}

async function downloadRequest(connection: CloudDrive): Promise<{ name: string; request: TransferRequest }> {
  const authorization = await authorizationHeader(connection.auth);
  const remote = connection.remote;
  switch (connection.auth.provider) {
    case "dropbox":
      return { name: basename(remote), request: {
        url: "https://content.dropboxapi.com/2/files/download", method: "POST", authorization,
        headers: { "Dropbox-API-Arg": asciiJson({ path: remote }) },
      } };
    case "google": {
      const { info } = await googleMetadata(connection, authorization);
      connection.revision = info.headRevisionId;
      return { name: info.name ?? "Google-Drive.kdbx", request: {
        url: googleFiles + "/" + encodeURIComponent(remote) + "?alt=media&supportsAllDrives=true", authorization,
      } };
    }
    case "teams":
    case "onedrive": {
      const { info } = await metadata(graphFile(connection, true), authorization);
      connection.item = info.id;
      connection.revision = strongTag(info.eTag);
      const address = new URL(info["@microsoft.graph.downloadUrl"] ?? "");
      if (address.protocol !== "https:" || address.username || address.password || address.hash) {
        throw new Error("Microsoft Graph 未返回有效的 HTTPS 下载地址。");
      }
      // The signed URL already authorizes the download. Never forward the OAuth token.
      return { name: info.name ?? basename(remote), request: { url: address.href } };
    }
  }
}

export async function downloadCloud(connection: CloudDrive, destination: string, track: CancelRegistration) {
  const { name, request } = await downloadRequest(connection);
  const folder = await mkdtemp(join(destination, "Tinycast-" + connection.auth.provider + "-"));
  const path = join(folder, safeName(name));
  const headers = join(folder, "headers");
  let downloaded = false;
  try {
    const status = await transfer(request, path, headers, track);
    checkStatus(status);
    if (status !== 200) throw new Error("云端没有返回完整的密码库。");
    await chmod(path, 0o600);
    if (connection.auth.provider === "dropbox") {
      const raw = await responseHeader(headers, "Dropbox-API-Result");
      connection.revision = raw ? (JSON.parse(raw) as { rev?: string }).rev : undefined;
    }
    if (connection.auth.provider === "google" && connection.revision) {
      const after = await googleMetadata(connection, await authorizationHeader(connection.auth));
      if (after.info.headRevisionId !== connection.revision) throw new RemoteConflict();
    }
    downloaded = true;
    return path;
  } finally {
    await unlink(headers).catch(() => {});
    if (!downloaded) {
      await unlink(path).catch(() => {});
      await rmdir(folder).catch(() => {});
    }
  }
}

async function startGoogleCreate(name: string, snapshot: string, authorization: string) {
  const response = await fetch(googleUploads + "?uploadType=resumable&fields=id,headRevisionId", {
    method: "POST",
    headers: {
      Authorization: authorization, "Content-Type": "application/json",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String((await stat(snapshot)).size),
    },
    body: JSON.stringify({ name, mimeType: "application/octet-stream" }),
  });
  checkStatus(response.status);
  const address = new URL(response.headers.get("Location") ?? "");
  if (address.protocol !== "https:" || address.hostname !== "www.googleapis.com" || address.username || address.password || address.hash) {
    throw new Error("Google Drive 未提供有效的上传地址。");
  }
  return address.href;
}

async function uploadRequest(connection: CloudDrive, snapshot: string, create: boolean): Promise<TransferRequest> {
  if (!create && !connection.revision) throw new Error("缺少云端版本标识，请重新下载密码库。");
  const authorization = await authorizationHeader(connection.auth);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  switch (connection.auth.provider) {
    case "dropbox": {
      headers["Dropbox-API-Arg"] = asciiJson({
        path: connection.remote, mode: create ? "add" : { ".tag": "update", update: connection.revision },
        autorename: false, strict_conflict: true,
      });
      return { url: "https://content.dropboxapi.com/2/files/upload", method: "POST", authorization, headers, upload: snapshot };
    }
    case "google": {
      if (create) {
        const url = await startGoogleCreate(connection.remote, snapshot, authorization);
        return { url, method: "PUT", authorization, headers, upload: snapshot };
      }
      const current = await googleMetadata(connection, authorization);
      if (current.info.headRevisionId !== connection.revision) throw new RemoteConflict();
      if (current.etag) headers["If-Match"] = current.etag;
      const url = googleUploads + "/" + encodeURIComponent(connection.remote)
        + "?uploadType=media&fields=id,headRevisionId&supportsAllDrives=true";
      return { url, method: "PATCH", authorization, headers, upload: snapshot };
    }
    case "teams":
    case "onedrive": {
      const endpoint = graphFile(connection, !create);
      const content = !create && connection.item ? "/content" : ":/content";
      if (create) headers["If-None-Match"] = "*";
      else headers["If-Match"] = connection.revision!;
      const url = endpoint + content + (create ? "?%40microsoft.graph.conflictBehavior=fail" : "");
      return { url, method: "PUT", authorization, headers, upload: snapshot };
    }
  }
}

export async function uploadCloud(
  connection: CloudDrive, path: string, track: CancelRegistration, checkSource: () => Promise<void>, create = false,
) {
  const folder = await mkdtemp(join(tmpdir(), "tinycast-cloud-upload-"));
  const snapshot = join(folder, "vault.kdbx");
  const headers = join(folder, "headers");
  const response = join(folder, "response.json");
  try {
    await checkSource();
    await copyFile(path, snapshot);
    await checkSource();
    const request = await uploadRequest(connection, snapshot, create);
    checkStatus(await transfer(request, response, headers, track));
    connection.revision = undefined;
    const reply = JSON.parse(await readFile(response, "utf8")) as FileMetadata & { rev?: string };
    switch (connection.auth.provider) {
      case "dropbox":
        connection.revision = reply.rev;
        break;
      case "google":
        connection.revision = reply.headRevisionId;
        if (create) {
          if (!reply.id) throw new Error("Google Drive 已接收文件，但未返回文件 ID。请在网盘中检查后再试。");
          connection.remote = reply.id;
        }
        break;
      default:
        connection.revision = strongTag(reply.eTag);
        connection.item = reply.id ?? connection.item;
    }
  } finally {
    await unlink(response).catch(() => {});
    await unlink(headers).catch(() => {});
    await unlink(snapshot).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}
