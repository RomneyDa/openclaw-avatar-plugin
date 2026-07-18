import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json", "--silent"],
  { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" } },
);
const pack = JSON.parse(output.trim());
if (!Array.isArray(pack) || !pack[0]) throw new Error("npm pack did not return package metadata");
const metadata = pack[0];
const entries = metadata.files.map((file) => file.path).sort();
const required = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "dist/browser/client.js",
  "dist/browser/styles.css",
  "dist/demo.mjs",
  "dist/index.mjs",
  "dist/types/index.d.ts",
  "openclaw.plugin.json",
  "package.json",
];
for (const entry of required) {
  if (!entries.includes(entry)) throw new Error(`package is missing required entry: ${entry}`);
}
const forbidden = entries.filter((entry) =>
  /(^|\/)(?:tmp|tests|coverage|node_modules|\.git|\.worktrees)(?:\/|$)|\.test\.[cm]?[jt]s$/u.test(entry),
);
if (forbidden.length > 0) throw new Error(`package contains forbidden entries:\n${forbidden.join("\n")}`);

const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/u,
];
for (const entry of entries) {
  const filename = path.join(root, entry);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) continue;
  const contents = fs.readFileSync(filename, "utf8");
  if (credentialPatterns.some((pattern) => pattern.test(contents))) {
    throw new Error(`package entry looks like it contains a credential: ${entry}`);
  }
}
console.log(`package verification passed: ${entries.length} files, ${metadata.size} bytes packed`);
