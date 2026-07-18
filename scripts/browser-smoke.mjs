import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { AvatarBrowserHost, AvatarSession } from "../dist/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(
  root,
  outputIndex >= 0 && process.argv[outputIndex + 1]
    ? process.argv[outputIndex + 1]
    : "tmp/avatar-browser-smoke.png",
);
fs.mkdirSync(path.dirname(output), { recursive: true });

const session = new AvatarSession();
const host = new AvatarBrowserHost({ session, assetsPath: path.join(root, "dist", "browser") });
await host.startStandalone(0);
session.start({ sessionId: "browser-smoke", video: { width: 1280, height: 720, frameRate: 30 } });
session.state("listening", 0);

const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(host.rendererUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status-label")?.textContent === "LISTENING");

  const samples = 480;
  for (let chunk = 0; chunk < 24; chunk += 1) {
    const pcm = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
      const time = (chunk * samples + index) / 24_000;
      const envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 3.2 * time));
      const value = Math.sin(2 * Math.PI * 126 * time) * envelope * 0.68;
      pcm.writeInt16LE(Math.round(value * 30_000), index * 2);
    }
    session.audio(pcm, chunk * 20);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await page.waitForFunction(() => document.querySelector("#status-label")?.textContent === "SPEAKING");
  await page.screenshot({ path: output });
  const proof = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("avatar canvas is missing");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("avatar 2D context is missing");
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let foreground = 0;
    for (let offset = 0; offset < data.length; offset += 4 * 97) {
      if ((data[offset] ?? 0) > 70 || (data[offset + 1] ?? 0) > 70 || (data[offset + 2] ?? 0) > 90) foreground += 1;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      foreground,
      status: document.querySelector("#status-label")?.textContent,
    };
  });
  if (proof.foreground < 400 || proof.status !== "SPEAKING") {
    throw new Error(`browser frame failed visual proof: ${JSON.stringify(proof)}`);
  }
  const hostSnapshot = host.snapshot();
  if (!hostSnapshot.firstFrameValidated || hostSnapshot.readyClients !== 1) {
    throw new Error(`renderer did not report validated readiness: ${JSON.stringify(hostSnapshot)}`);
  }
  session.clear("barge-in");
  await page.waitForTimeout(50);
  console.log(`browser smoke passed: ${JSON.stringify({ ...proof, output })}`);
} finally {
  await browser.close();
  session.end("browser-smoke-complete");
  await host.stop();
}
