import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugins = join(root, "plugins");
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });

for (const entry of await readdir(plugins, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const dist = join(plugins, entry.name, "dist");
  const manifest = JSON.parse(await readFile(join(dist, "package.json"), "utf8"));
  await access(join(dist, "assets", manifest.icon));
  await Promise.all(manifest.commands.map(({ name }) => access(join(dist, name + ".js"))));

  const staging = await mkdtemp(join(artifacts, ".package-"));
  const folder = manifest.name;
  const filename = folder + "-" + manifest.version + ".zip";
  try {
    await cp(dist, join(staging, folder), { recursive: true });
    execFileSync("zip", ["-q", "-r", filename, folder], { cwd: staging });
    await rename(join(staging, filename), join(artifacts, filename));
    console.log("artifacts/" + filename);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
