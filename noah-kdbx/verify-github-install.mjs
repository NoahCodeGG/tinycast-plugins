import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyInstall(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const assets = join(directory, "assets");
  if (!manifest.commands?.length) throw new Error(manifest.name + " has no commands.");

  await access(join(assets, manifest.icon));
  for (const { name } of manifest.commands) {
    await access(join(directory, name + ".js"));
  }

  if (manifest.name === "noah-kdbx") {
    await access(join(assets, "kdbx-helper", "tinycast-kdbx"), constants.X_OK);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyInstall(process.cwd());
}
