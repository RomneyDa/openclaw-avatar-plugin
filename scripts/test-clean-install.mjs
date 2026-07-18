import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-avatar-install-"));
try {
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "avatar-clean-install", private: true, type: "module" }),
  );
  const packOutput = execFileSync(
    "npm",
    ["pack", "--pack-destination", directory, "--ignore-scripts", "--json", "--silent"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" } },
  );
  const packed = JSON.parse(packOutput.trim());
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not produce a tarball");
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `openclaw@2026.7.2-beta.2`,
      path.join(directory, filename),
    ],
    { cwd: directory, stdio: "pipe", env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" } },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const plugin = await import('openclaw-avatar-plugin'); if (typeof plugin.default?.register !== 'function' || typeof plugin.AvatarSession !== 'function') throw new Error('plugin exports failed to load');",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  console.log("clean packed install passed: plugin entry and public session core loaded");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
