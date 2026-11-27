import { Clipboard, environment, showToast, Toast } from "@raycast/api";
import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { calculateSheet } from "./calculate";
import { sheetTitle, type Sheet } from "./sheets";

const render = promisify(execFile);
let copying = false;

export async function copySheetImage(sheet: Sheet) {
  if (copying) return;
  copying = true;
  try {
    const folder = join(tmpdir(), "noah-calcpad");
    await mkdir(folder, { mode: 0o700, recursive: true });
    const input = join(folder, "sheet.json");
    const png = join(folder, "计算稿纸.png");
    try {
      await writeFile(input, JSON.stringify({ title: sheetTitle(sheet), rows: calculateSheet(sheet.body) }), { mode: 0o600 });
      await render("/usr/bin/osascript", ["-l", "JavaScript", join(environment.assetsPath, "render-sheet.js"), input, png]);
      await Clipboard.copy({ file: png });
    } finally {
      await unlink(input).catch(() => {});
    }
    await showToast({ style: Toast.Style.Success, title: "已复制稿纸图片" });
  } catch {
    await showToast({ style: Toast.Style.Failure, title: "无法复制稿纸图片" });
  } finally {
    copying = false;
  }
}
