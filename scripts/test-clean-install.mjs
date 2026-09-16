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
      path.join(directory, filename),
    ],
    { cwd: directory, stdio: "pipe", env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" } },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "const rendererModule = await import('openclaw-avatar-plugin/renderer');",
        "if (typeof rendererModule.createAvatarRenderer !== 'function') throw new Error('renderer subpath failed to load');",
        "const renderer = rendererModule.createAvatarRenderer({ token: 'clean-install-proof' });",
        "await renderer.start();",
        "try { const response = await fetch(renderer.rendererUrl); if (!response.ok) throw new Error('packaged renderer failed to serve'); }",
        "finally { await renderer.stop(); }",
      ].join(" "),
    ],
    { cwd: directory, stdio: "inherit" },
  );
  console.log("clean packed install passed: default renderer assets served without OpenClaw, FaceTime, OBS, or provider code");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
