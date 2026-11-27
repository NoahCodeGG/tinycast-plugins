import { environment } from "@raycast/api";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { join } from "node:path";

export type Credentials = { database: string; master: string; keyfile?: string };
export type Field = "username" | "password" | "url" | "notes" | "totp";
export type Entry = {
  id: string;
  title: string;
  username: string;
  url: string;
  group: string;
  group_id: string;
  color: string | null;
  icon: string | null;
  tags: string[];
  trashed: boolean;
  has_secret: boolean;
  has_notes: boolean;
  has_totp: boolean;
  has_history: boolean;
  has_attachments: boolean;
};

export type Changes = Partial<Record<"title" | "otp" | "group" | "color" | "icon" | "icon_file" | Exclude<Field, "totp">, string>> & { tags?: string[] };
export type Group = { id: string; name: string; path: string; root: boolean; trashed: boolean; recycle_bin: boolean };
export type Version = { index: number; has_attachments: boolean; title: string; username: string; modified: string | null };
export type Attachment = { name: string; size: number };
export type CustomField = { name: string; protected: boolean; value: string | null };
export type EntryDetails = { kind: "details"; versions: Version[]; attachments: Attachment[]; custom: CustomField[] };
export type Management =
  | { kind: "add_group"; parent: string; title: string }
  | { kind: "rename_group"; group: string; title: string }
  | { kind: "move_group"; group: string; parent: string }
  | { kind: "trash_group" | "restore_group" | "purge_group"; group: string }
  | { kind: "trash_entry" | "restore_entry" | "purge_entry"; entry: string }
  | { kind: "add_attachment"; entry: string; path: string }
  | { kind: "remove_attachment"; entry: string; attachment: string }
  | { kind: "set_custom"; entry: string; field: string; value: string; protected: boolean; existing: boolean }
  | { kind: "remove_custom"; entry: string; field: string }
  | { kind: "restore_history" | "delete_history"; entry: string; index: number };
export type Vault = { kind: "list"; stamp: string; entries: Entry[]; groups: Group[]; icons: Record<string, string>; writable: boolean; database?: string; backup?: string | null };
export type WriteOperation =
  | { kind: "save_copy"; stamp: string; name: string; replace?: boolean; entry?: string; fields: Changes }
  | { kind: "manage_copy"; stamp: string; name: string; replace?: boolean; change: Management };
type Operation =
  | { kind: "list" }
  | { kind: "create"; name: string }
  | { kind: "read"; stamp: string; entry: string; field: Field }
  | { kind: "search"; stamp: string; pattern: string; regex: boolean; include_protected: boolean; history: boolean; trash: boolean }
  | { kind: "read_custom"; stamp: string; entry: string; field: string }
  | { kind: "rekey"; stamp: string; name: string; new_master: string; new_keyfile?: string }
  | { kind: "merge"; stamp: string; name: string; remote: string }
  | { kind: "inspect"; stamp: string; entry: string; history?: number }
  | { kind: "preview"; stamp: string; entry: string; attachment: string; history?: number }
  | { kind: "export"; stamp: string; entry: string; attachment: string; history?: number; directory: string; name: string }
  | WriteOperation;
type Replies = { list: Vault; create: Vault; rekey: Vault; merge: Vault; save_copy: Vault; manage_copy: Vault; read: { kind: "value"; value: string }; read_custom: { kind: "value"; value: string }; search: { kind: "matches"; ids: string[] }; inspect: EntryDetails; export: { kind: "exported" }; preview: { kind: "preview"; mime: "image/png" | "image/jpeg"; data: string } };
const messages = new Map([
  ["database_file", "无法读取密码库。请确认文件已下载到本机、可以读取且不超过 128 MiB。"],
  ["keyfile", "无法读取密钥文件，请检查文件位置和格式。"],
  ["format", "请选择 KeePass KDBX 3 或 4 格式的密码库。"],
  ["incomplete", "密码库数据不完整。如果文件来自 OneDrive，请在 Finder 中标记「始终保留在此设备上」，等下载完成后重试。"],
  ["invalid_data", "密码库头部的格式或加密参数无法识别（invalid_data）。"],
  ["invalid_header", "密码库头部校验失败（invalid_header）。请核对同一文件的 OneDrive 版本或备份。"],
  ["invalid_blocks", "凭据校验通过，但密码库数据块校验失败（invalid_blocks）。请核对同一文件的 OneDrive 版本或备份。"],
  ["invalid_xml", "密码库已解密，但插件无法解析内部 XML（invalid_xml）。请用 KeeWeb 打开同一个文件以确认兼容性。"],
  ["invalid_inner_header", "密码库已解密，但插件无法解析内部头部（invalid_inner_header）。"],
  ["duplicate_entry", "密码库已解密，但有多条记录使用相同的内部 ID（duplicate_entry）。"],
  ["duplicate_group", "密码库已解密，但有多个分组使用相同的内部 ID（duplicate_group）。"],
  ["protected_encoding", "密码库已解密，但有受保护字段使用了不兼容的 Base64 编码（protected_encoding）。"],
  ["protected_data", "密码库已解密，但插件无法读取内部受保护字段（protected_data）。"],
  ["unlock", "无法解锁。请核对密码库的主密码，并选上创建该库时用的密钥文件（如有）。"],
  ["decrypt", "无法解密密码库。请用 KeeWeb 打开同一文件，确认主密码、密钥文件和加密设置。"],
  ["changed", "密码库文件已更改，请重新解锁。"],
  ["merge_remote", "无法用当前凭据解锁远端版本。本地和远端文件均已保留。"],
  ["merge_unrelated", "远端文件属于另一密码库，已中止合并。"],
  ["merge_conflict", "无法安全合并两份密码库，请核对两边的改动。"],
  ["group", "找不到可用的分组。"],
  ["group_move", "无法移动该分组。请选择根分组或其他有效上级。"],
  ["group_name", "分组名称须为 1 到 128 个字符。"],
  ["tags", "每条记录最多 64 个标签，每个标签最多 128 个字符。"],
  ["history", "找不到这条历史版本。"],
  ["attachment", "找不到这个附件。"],
  ["attachment_name", "请输入有效的附件文件名。"],
  ["attachment_exists", "条目中已有同名附件。"],
  ["attachment_import", "无法读取附件，或附件超过 32 MiB。"],
  ["preview_format", "当前附件无法预览。请选择有效的 PNG 或 JPEG。"],
  ["preview_size", "图片超过预览大小限制，可使用导出。"],
  ["attachment_export", "无法导出附件，请检查目录写入权限。"],
  ["icon_file", "请选择 1 MiB 以内、宽高不超过 1,024 像素的 PNG 或 JPEG 图标。"],
  ["new_key", "请设置主密码或选择密钥文件。"],
  ["color", "条目颜色无效。"],
  ["custom_field", "字段名称不能使用内置字段名，名称最多 128 个字符，值最多 2,000 个字符。"],
  ["custom_exists", "此条目已有同名字段。"],
  ["search_pattern", "搜索内容无效。请输入不超过 512 个字符的文本或有效正则表达式。"],
  ["entry", "找不到这条记录，请重新解锁。"],
  ["otp", "此条目的 TOTP 设置无效。请使用有效的 otpauth://totp/ 链接。"],
  ["field", "这条记录没有可复制的内容。"],
  ["readonly", "此格式只能读取。编辑副本需要 KDBX 4。"],
  ["name", "请输入有效的 .kdbx 文件名。"],
  ["exists", "同名文件已存在，请使用其他名称。"],
  ["replace_file", "当前文件或目录不支持原地更新，请改用保存副本。"],
  ["replace_conflict", "检测到同时写入。已保留同目录加密备份，请重新打开前核对文件。"],
  ["save", "无法保存密码库，请检查目录写入权限。"],
  ["too_many", "此版本支持每个库最多 5,000 条可见记录。"],
]);

export class VaultError extends Error {
  constructor(readonly code: string) {
    super(messages.get(code) ?? "密码库读取组件未能完成操作。请检查安装或重试。");
  }
}

export function runHelper<T extends Operation>(credentials: Credentials, operation: T) {
  const file = join(environment.assetsPath, "kdbx-helper", "tinycast-kdbx");
  const process = spawn(file, [], { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
  const result = new Promise<Replies[T["kind"]]>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    process.stderr.resume();
    process.stdout.on("data", (chunk: Uint8Array) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        process.kill();
        reject(new VaultError("too_many"));
        return;
      }
      chunks.push(chunk);
    });
    process.on("error", () => reject(new VaultError("helper")));
    process.stdin.on("error", () => reject(new VaultError("helper")));
    process.on("close", (status) => {
      try {
        if (status !== 0 || bytes > 16 * 1024 * 1024) throw new VaultError("helper");
        const buffer = Buffer.concat(chunks);
        try {
          const response = JSON.parse(buffer.toString("utf8"));
          if (response.kind === "error") throw new VaultError(response.code);
          const expectsVault = operation.kind === "list" || operation.kind === "create"
            || operation.kind === "save_copy" || operation.kind === "manage_copy" || operation.kind === "rekey"
            || operation.kind === "merge";
          if (expectsVault && response.kind === "list" && typeof response.stamp === "string"
              && typeof response.writable === "boolean" && Array.isArray(response.entries) && Array.isArray(response.groups) && response.icons && typeof response.icons === "object"
              && (operation.kind === "list" || typeof response.database === "string")
              || (operation.kind === "read" || operation.kind === "read_custom") && response.kind === "value" && typeof response.value === "string"
              || operation.kind === "inspect" && response.kind === "details" && Array.isArray(response.versions) && Array.isArray(response.attachments) && Array.isArray(response.custom)
              || operation.kind === "search" && response.kind === "matches" && Array.isArray(response.ids)
              || operation.kind === "export" && response.kind === "exported"
              || operation.kind === "preview" && response.kind === "preview"
                && ["image/png", "image/jpeg"].includes(response.mime) && typeof response.data === "string") {
            resolve(response);
          } else {
            throw new VaultError("helper");
          }
        } finally {
          buffer.fill(0);
        }
      } catch (error) {
        reject(error instanceof VaultError ? error : new VaultError("helper"));
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    process.stdin.end(JSON.stringify({ ...credentials, operation }));
  });
  return { result, cancel: () => { process.kill(); } };
}
