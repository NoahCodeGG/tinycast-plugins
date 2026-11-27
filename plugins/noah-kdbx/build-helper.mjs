import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The KDBX helper builds on macOS.");

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = join(root, "helper", "Cargo.toml");
const target = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--locked", "--format-version", "1", "--filter-platform", target, "--manifest-path", manifest,
], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
execFileSync("cargo", ["build", "--locked", "--release", "--target", target, "--manifest-path", manifest], {
  stdio: "inherit",
});
const binary = join(metadata.target_directory, target, "release", "tinycast-kdbx");
const resolved = new Set(metadata.resolve.nodes.map(({ id }) => id));
const dependencies = metadata.packages.filter(({ id, source, name }) => (source || name === "keepass") && resolved.has(id));

const assets = join(root, "assets");
const output = join(assets, "kdbx-helper");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const helper = join(output, "tinycast-kdbx");
await copyFile(binary, helper);
execFileSync("codesign", ["--force", "--sign", "-", helper]);

const notices = [];
for (const dependency of dependencies.sort((a, b) => a.name.localeCompare(b.name))) {
  const directory = dirname(dependency.manifest_path);
  const files = (await readdir(directory)).filter((name) => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
  if (dependency.license_file && !files.includes(dependency.license_file)) files.push(dependency.license_file);
  const contents = await Promise.all(files.sort().map((name) => readFile(join(directory, name), "utf8")));
  notices.push([dependency.name + " " + dependency.version + " — " + (dependency.license ?? "See license"), ...contents].join("\n\n"));
}
await writeFile(join(assets, "RUST-DEPENDENCIES.txt"), notices.join("\n\n" + "-".repeat(70) + "\n\n") + "\n");
