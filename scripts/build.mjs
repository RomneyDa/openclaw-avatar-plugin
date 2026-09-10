import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist");
const watch = process.argv.includes("--watch");
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(path.join(outdir, "browser"), { recursive: true });

const nodeBuild = {
  absWorkingDir: root,
  entryPoints: { index: "index.ts", renderer: "src/renderer.ts", demo: "src/demo.ts" },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  external: ["ws"],
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
};

const browserBuild = {
  absWorkingDir: root,
  entryPoints: ["browser/client.ts"],
  outfile: path.join(outdir, "browser", "client.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["chrome120", "safari17"],
  minify: true,
  sourcemap: true,
  logLevel: "info",
};

fs.copyFileSync(path.join(root, "browser", "styles.css"), path.join(outdir, "browser", "styles.css"));

if (watch) {
  const [nodeContext, browserContext] = await Promise.all([context(nodeBuild), context(browserBuild)]);
  await Promise.all([nodeContext.watch(), browserContext.watch()]);
  console.log("watching avatar renderer sources");
} else {
  await Promise.all([build(nodeBuild), build(browserBuild)]);
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], {
    cwd: root,
    stdio: "inherit",
  });
}
