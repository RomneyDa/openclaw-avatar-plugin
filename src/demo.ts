import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AvatarBrowserHost } from "./browser-host.js";
import { AvatarSession } from "./session.js";

const session = new AvatarSession();
const host = new AvatarBrowserHost({
  session,
  assetsPath: fileURLToPath(new URL("./browser/", import.meta.url)),
});
await host.startStandalone(0);
session.start({ sessionId: "synthetic-demo", video: { width: 1280, height: 720, frameRate: 30 } });
session.state("listening", 0);

console.log(`OpenClaw Avatar demo: ${host.rendererUrl}`);
if (process.argv.includes("--open")) {
  execFile("open", [host.rendererUrl], () => {});
}

let sampleOffset = 0;
let elapsedMs = 0;
let phase: "listening" | "thinking" | "speaking" = "listening";
let phaseStarted = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  const phaseAge = now - phaseStarted;
  if (phase === "listening" && phaseAge > 1600) {
    phase = "thinking";
    phaseStarted = now;
    session.state("thinking", elapsedMs);
  } else if (phase === "thinking" && phaseAge > 1200) {
    phase = "speaking";
    phaseStarted = now;
    session.state("speaking", elapsedMs);
  } else if (phase === "speaking" && phaseAge > 5600) {
    session.clear("cancel");
    phase = "listening";
    phaseStarted = now;
    session.state("listening", 0);
    elapsedMs = 0;
    sampleOffset = 0;
  }

  if (phase !== "speaking") return;
  const samples = 480;
  const pcm = Buffer.alloc(samples * 2);
  let envelopeSum = 0;
  for (let index = 0; index < samples; index += 1) {
    const time = (sampleOffset + index) / 24_000;
    const syllable = Math.pow(Math.max(0, Math.sin(Math.PI * 3.1 * time)), 0.55);
    const phrase = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, (phaseAge - 1200) / 4400));
    const envelope = syllable * phrase;
    envelopeSum += envelope;
    const voice =
      Math.sin(2 * Math.PI * 118 * time) * 0.5 +
      Math.sin(2 * Math.PI * 236 * time) * 0.22 +
      Math.sin(2 * Math.PI * 590 * time) * 0.1;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, voice * envelope)) * 26_000), index * 2);
  }
  const openness = Math.min(1, (envelopeSum / samples) * 1.4);
  session.visemes({ aa: openness, E: (1 - openness) * 0.35, sil: 1 - openness }, elapsedMs);
  session.audio(pcm, elapsedMs);
  sampleOffset += samples;
  elapsedMs += 20;
}, 20);

const shutdown = async () => {
  clearInterval(timer);
  session.end("demo-stopped");
  await host.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
