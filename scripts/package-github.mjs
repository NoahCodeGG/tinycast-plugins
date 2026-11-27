import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInstall } from "./verify-github-install.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugins = join(root, "plugins");
const artifacts = join(root, "artifacts");
const output = join(artifacts, "github-install");
await mkdir(artifacts, { recursive: true });
const staging = await mkdtemp(join(artifacts, ".github-install-"));

try {
  for (const entry of await readdir(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const dist = join(plugins, entry.name, "dist");
    const target = join(staging, entry.name);
    await cp(dist, target, { recursive: true });

    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== entry.name) throw new Error("Unexpected plugin name in " + manifestPath);
    manifest.scripts = { build: "node verify-github-install.mjs" };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await cp(fileURLToPath(new URL("./verify-github-install.mjs", import.meta.url)), join(target, "verify-github-install.mjs"));
    await verifyInstall(target);
    console.log(entry.name + "@" + manifest.version);
  }

  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
