import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const visible = process.argv.includes("--headed");
const outputDir = visible
  ? path.join(root, "tmp", "live-visible")
  : path.join(root, "docs", "evidence");
const candidates = [
  process.env.OPENCLAW_CORE_PATH,
  path.resolve(root, "../openclaw"),
  path.resolve(root, "../../../openclaw/.worktrees/avatar-live-demo"),
].filter(Boolean);
const coreRoot = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "scripts", "dev", "avatar-live-demo.ts")),
);

if (!coreRoot) {
  console.error(
    "OpenClaw live-demo helper not found. Set OPENCLAW_CORE_PATH to the demo/avatar-live checkout.",
  );
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsx",
    "scripts/dev/avatar-live-demo.ts",
    "--plugin-root",
    root,
    "--output-dir",
    outputDir,
    ...process.argv.slice(2),
  ],
  { cwd: coreRoot, env: process.env, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
