import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");
const manifest = JSON.parse(await readFile(join(root, "src/manifest.json"), "utf8"));
const { name, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const entries = Object.fromEntries(
  manifest.commands.map(({ name }) => [name, join(root, "src/commands", name + ".tsx")]),
);

const result = await build({
  entryPoints: entries,
  outdir: dist,
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022",
  charset: process.argv.includes("--utf8") ? "utf8" : "ascii",
  jsx: "automatic",
  minify: true,
  external: ["@raycast/api", "react", "react/jsx-runtime"],
});

for (const file of result.outputFiles) {
  if (file.contents.length > 300 * 1024) throw new Error(file.path + " exceeds 300 KiB");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "assets"), join(dist, "assets"), {
  recursive: true,
  filter: (path) => !path.endsWith(".DS_Store"),
});

// Tinycast caches icons by file path. A content hash gives changed artwork a fresh path.
const extension = extname(manifest.icon);
const iconPath = join(dist, "assets", manifest.icon);
const hash = createHash("sha256").update(await readFile(iconPath)).digest("hex").slice(0, 8);
const icon = manifest.icon.slice(0, -extension.length) + "-" + hash + extension;
await rename(iconPath, join(dist, "assets", icon));

await Promise.all(result.outputFiles.map((file) => writeFile(file.path, file.contents)));
await writeFile(join(dist, "package.json"), JSON.stringify({ ...manifest, name, version, icon }, null, 2) + "\n");
console.log(name + " · " + result.outputFiles.map((file) => (file.contents.length / 1024).toFixed(1) + " KiB").join(", "));
