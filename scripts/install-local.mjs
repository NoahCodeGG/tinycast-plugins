import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
const slug = /^[a-z0-9][a-z0-9-]*$/;
if (process.platform !== "darwin" || !slug.test(name ?? "") || process.argv.length !== 3) {
  throw new Error("Usage on macOS: pnpm install:local <plugin-name>");
}

const source = fileURLToPath(new URL(`../plugins/${name}/dist/`, import.meta.url));
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (manifest.name !== name || !manifest.commands?.length || manifest.commands.some(({ name }) => !slug.test(name))) {
  throw new Error(`Invalid built manifest for ${name}`);
}
await Promise.all(manifest.commands.map(({ name }) => access(join(source, `${name}.js`))));

const extensions = join(homedir(), "Library/Application Support/com.abueammar.tinycast/extensions");
await mkdir(extensions, { recursive: true });
const destination = join(extensions, name);
const staging = join(extensions, `.${name}-install`);
const incoming = join(staging, "incoming");
const previous = join(staging, "previous");
await mkdir(staging);
let backedUp = false;
let ready = false;

try {
  await mkdir(incoming);
  await cp(join(source, "package.json"), join(incoming, "package.json"));
  await Promise.all(manifest.commands.map(({ name }) => cp(join(source, `${name}.js`), join(incoming, `${name}.js`))));
  await cp(join(source, "assets"), join(incoming, "assets"), { recursive: true });
  try {
    await rename(destination, previous);
    backedUp = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(incoming, destination);
  ready = true;
} finally {
  if (backedUp && !ready) await rename(previous, destination);
  await rm(staging, { recursive: true, force: true });
}

console.log(`Installed ${name} ${manifest.version} in Tinycast`);
