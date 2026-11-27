import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("Building noah-color requires macOS and Xcode Command Line Tools.");

execFileSync(process.execPath, ["../../scripts/build.mjs"], { stdio: "inherit" });
execFileSync("/usr/bin/clang", [
  "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0",
  "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-framework", "AppKit", "-framework", "ImageIO",
  "helper/color.m", "-o", "dist/assets/color-helper",
], { stdio: "inherit" });
