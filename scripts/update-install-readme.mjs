import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [publishedDirectory, readmePath, repositoryUrl] = process.argv.slice(2);
if (process.argv.length !== 5 || !publishedDirectory || !readmePath || !repositoryUrl) {
  throw new Error("Usage: node scripts/update-install-readme.mjs <published-directory> <readme-path> <repository-url>");
}

const start = "<!-- tinycast-install-table:start -->";
const end = "<!-- tinycast-install-table:end -->";
const source = await readFile(readmePath, "utf8");
const parts = source.split(start);
const tableParts = parts[1]?.split(end);
if (parts.length !== 2 || tableParts?.length !== 2 || parts[0].includes(end)) {
  throw new Error("README must contain one pair of Tinycast install table markers in order.");
}

const entries = await readdir(publishedDirectory, { withFileTypes: true });
const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name).sort();
if (names.length === 0) throw new Error("No published Tinycast plugins found.");

const directoryUrl = new URL(repositoryUrl.replace(/\/+$/, "") + "/tree/tinycast-install/");
const tableText = (value) => value.trim().replace(/\s+/g, " ")
  .replace(/[&<>|\\`*_\[\]~]/g, (character) => "&#" + character.charCodeAt(0) + ";");
const rows = await Promise.all(names.map(async (name) => {
  const manifest = JSON.parse(await readFile(join(publishedDirectory, name, "package.json"), "utf8"));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || manifest.name !== name ||
      typeof manifest.title !== "string" || !manifest.title.trim() || !manifest.commands?.length) {
    throw new Error("Invalid published manifest: " + name);
  }
  const description = typeof manifest.description === "string" ? tableText(manifest.description) : "";
  const guidePath = "plugins/" + name + "/README.md";
  const guide = await stat(join(dirname(readmePath), guidePath)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const docs = guide?.isFile() ? "[使用说明](" + guidePath + ")" : "—";
  return "| " + [tableText(manifest.title), description || "—", docs,
    "[" + name + "](" + new URL(name, directoryUrl).href + ")"].join(" | ") + " |";
}));

const newline = source.includes("\r\n") ? "\r\n" : "\n";
const table = ["", "", "| 插件 | 主要功能 | 文档 | GitHub 安装目录 |", "| --- | --- | --- | --- |", ...rows, "", ""].join(newline);
const updated = parts[0] + start + table + end + tableParts[1];
if (updated !== source) await writeFile(readmePath, updated, "utf8");
