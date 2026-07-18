type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "error";
type WireEvent = {
  type?: string;
  generation?: number;
  sequence?: number;
  ptsMs?: number;
  state?: AvatarState;
  weights?: Record<string, number>;
  pcmBase64?: string;
  name?: string;
  intensity?: number;
  video?: { width: number; height: number; frameRate: number };
  snapshot?: { generation?: number; currentState?: AvatarState };
};

type AvatarRendererProof = {
  generation: number;
  state: AvatarState;
  lastSequence: number;
  receivedAudioEvents: number;
  receivedAudioBytes: number;
  receivedAudioHash: string;
  clearEvents: number;
  renderedFrames: number;
  audioLevel: number;
  audioTarget: number;
};

type AudioEnvelopeFrame = {
  startPtsMs: number;
  endPtsMs: number;
  level: number;
};

const canvas = document.querySelector<HTMLCanvasElement>("#avatar")!;
const context = canvas.getContext("2d", { alpha: false })!;
const status = document.querySelector<HTMLElement>("#status")!;
const statusLabel = document.querySelector<HTMLElement>("#status-label")!;
const errorBox = document.querySelector<HTMLElement>("#error")!;
const token = new URL(location.href).searchParams.get("token") ?? "";
const routeBase = location.pathname.replace(/\/$/u, "");
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(
  `${protocol}//${location.host}${routeBase}/stream?token=${encodeURIComponent(token)}`,
);

let state: AvatarState = "idle";
let generation = 0;
let lastSequence = -1;
let audioLevel = 0;
let audioTarget = 0;
let audioClockOrigin: number | null = null;
let audioEndPtsMs = 0;
let audioEnvelope: AudioEnvelopeFrame[] = [];
let pendingState: AvatarState | null = null;
let visemeOpen = 0;
let visemeWide = 0;
let expressionPulse = 0;
let expressionTarget = 0;
let renderedFrames = 0;
let firstFrameReported = false;
let connected = false;
let nextBlinkAt = performance.now() + 1600;
let blinkStartedAt: number | null = null;
let blink = 0;
let lastTime = performance.now();
let reportAt = 0;
let receivedAudioEvents = 0;
let receivedAudioBytes = 0;
let receivedAudioHash = 0xcbf29ce484222325n;
let clearEvents = 0;

Object.defineProperty(globalThis, "openclawAvatarProof", {
  configurable: false,
  enumerable: false,
  get: (): AvatarRendererProof => ({
    generation,
    state,
    lastSequence,
    receivedAudioEvents,
    receivedAudioBytes,
    receivedAudioHash: receivedAudioHash.toString(16).padStart(16, "0"),
    clearEvents,
    renderedFrames,
    audioLevel,
    audioTarget,
  }),
});

const stateLabels: Record<AvatarState, string> = {
  idle: "IDLE",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  error: "DEGRADED",
};

function setState(next: AvatarState): void {
  state = next;
  status.dataset.state = next;
  statusLabel.textContent = connected ? stateLabels[next] : "CONNECTING";
  if (next !== "error") {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
}

function clearMouth(): void {
  audioLevel = 0;
  audioTarget = 0;
  audioClockOrigin = null;
  audioEndPtsMs = 0;
  audioEnvelope = [];
  pendingState = null;
  visemeOpen = 0;
  visemeWide = 0;
  expressionPulse = 0;
  expressionTarget = 0;
  draw(performance.now(), true);
}

function pcmLevel(binary: string, startSample: number, endSample: number): number {
  if (endSample <= startSample) return 0;
  let sum = 0;
  let measured = 0;
  for (let index = startSample; index < endSample; index += 2) {
    const offset = index * 2;
    let sample = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    const normalized = sample / 32768;
    sum += normalized * normalized;
    measured += 1;
  }
  if (measured === 0) return 0;
  return Math.min(1, Math.max(0, (Math.sqrt(sum / measured) - 0.008) * 8.5));
}

function decodePcmEnvelope(base64: string, ptsMs: number): AudioEnvelopeFrame[] {
  const binary = atob(base64);
  receivedAudioEvents += 1;
  receivedAudioBytes += binary.length;
  for (let index = 0; index < binary.length; index += 1) {
    receivedAudioHash ^= BigInt(binary.charCodeAt(index));
    receivedAudioHash = BigInt.asUintN(64, receivedAudioHash * 0x100000001b3n);
  }
  const samples = Math.floor(binary.length / 2);
  const frames: AudioEnvelopeFrame[] = [];
  const windowSamples = 480;
  for (let start = 0; start < samples; start += windowSamples) {
    const end = Math.min(samples, start + windowSamples);
    frames.push({
      startPtsMs: ptsMs + start / 24,
      endPtsMs: ptsMs + end / 24,
      level: pcmLevel(binary, start, end),
    });
  }
  return frames;
}

function queuePcmEnvelope(base64: string, ptsMs: number): void {
  const frames = decodePcmEnvelope(base64, ptsMs);
  if (frames.length === 0) return;
  const now = performance.now();
  const playbackPts = audioClockOrigin === null ? null : now - audioClockOrigin;
  if (
    audioClockOrigin === null ||
    (audioEnvelope.length === 0 && playbackPts !== null && ptsMs > playbackPts + 100)
  ) {
    audioClockOrigin = now - ptsMs;
  }
  audioEnvelope.push(...frames);
  audioEndPtsMs = Math.max(audioEndPtsMs, frames.at(-1)?.endPtsMs ?? ptsMs);
}

function hasScheduledAudio(now = performance.now()): boolean {
  return (
    audioClockOrigin !== null &&
    (audioEnvelope.length > 0 || now - audioClockOrigin < audioEndPtsMs)
  );
}

function advanceAudioEnvelope(now: number): boolean {
  if (audioClockOrigin === null) return false;
  const playbackPts = now - audioClockOrigin;
  while (audioEnvelope[0] && audioEnvelope[0].endPtsMs <= playbackPts) {
    audioEnvelope.shift();
  }
  const frame = audioEnvelope[0];
  audioTarget = frame && frame.startPtsMs <= playbackPts ? frame.level : 0;
  if (audioEnvelope.length === 0 && playbackPts >= audioEndPtsMs) {
    audioClockOrigin = null;
    audioEndPtsMs = 0;
    audioTarget = 0;
    if (pendingState) {
      const nextState = pendingState;
      pendingState = null;
      setState(nextState);
    }
    return false;
  }
  return true;
}

function handleEvent(event: WireEvent): void {
  if (event.type === "host.hello") {
    generation = event.snapshot?.generation ?? generation;
    setState(event.snapshot?.currentState ?? state);
    return;
  }
  if (event.type === "session.start") {
    generation = event.generation ?? 0;
    lastSequence = -1;
    clearMouth();
    setState("idle");
    return;
  }
  const eventGeneration = event.generation ?? -1;
  if (eventGeneration < generation) return;
  if (event.type === "clear") {
    clearEvents += 1;
    generation = eventGeneration;
    lastSequence = -1;
    clearMouth();
    return;
  }
  if (eventGeneration > generation) {
    generation = eventGeneration;
    lastSequence = -1;
    clearMouth();
  }
  if ((event.type === "audio" || event.type === "visemes") && typeof event.sequence === "number") {
    if (lastSequence >= 0 && event.sequence !== lastSequence + 1) clearMouth();
    lastSequence = event.sequence;
  }
  if (event.type === "audio" && event.pcmBase64) {
    queuePcmEnvelope(event.pcmBase64, event.ptsMs ?? audioEndPtsMs);
    pendingState = null;
    setState("speaking");
  } else if (event.type === "visemes" && event.weights) {
    const weights = event.weights;
    visemeOpen = Math.min(
      1,
      (weights.aa ?? 0) + (weights.O ?? 0) * 0.9 + (weights.U ?? 0) * 0.72 + (weights.E ?? 0) * 0.45,
    );
    visemeWide = Math.min(1, (weights.E ?? 0) + (weights.I ?? 0) * 0.8 + (weights.SS ?? 0) * 0.55);
  } else if (event.type === "state" && event.state) {
    if (event.state !== "speaking" && hasScheduledAudio()) {
      pendingState = event.state;
    } else {
      setState(event.state);
    }
  } else if (event.type === "expression") {
    expressionTarget = Math.max(0, Math.min(1, event.intensity ?? 0));
  } else if (event.type === "session.end") {
    clearMouth();
    setState("idle");
  }
}

socket.addEventListener("open", () => {
  connected = true;
  setState(state);
});
socket.addEventListener("message", (message) => {
  try {
    handleEvent(JSON.parse(String(message.data)) as WireEvent);
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = error instanceof Error ? error.message : "Invalid avatar event";
    setState("error");
  }
});
socket.addEventListener("close", () => {
  connected = false;
  clearMouth();
  statusLabel.textContent = "DISCONNECTED";
});
socket.addEventListener("error", () => {
  errorBox.hidden = false;
  errorBox.textContent = "The local avatar event stream is unavailable.";
  setState("error");
});

function roundedRect(x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawBackdrop(width: number, height: number): void {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
}

function drawFace(cx: number, cy: number, scale: number): void {
  context.save();
  context.translate(cx, cy);

  const lobster = context.createLinearGradient(-50 * scale, -50 * scale, 50 * scale, 50 * scale);
  lobster.addColorStop(0, "#ff4d4d");
  lobster.addColorStop(1, "#991b1b");

  // Geometry follows the official openclaw.ai favicon; the animated mouth is the only addition.
  context.fillStyle = lobster;
  context.beginPath();
  context.moveTo(0, -50 * scale);
  context.bezierCurveTo(-30 * scale, -50 * scale, -45 * scale, -25 * scale, -45 * scale, -5 * scale);
  context.bezierCurveTo(-45 * scale, 15 * scale, -30 * scale, 35 * scale, -15 * scale, 40 * scale);
  context.lineTo(-15 * scale, 50 * scale);
  context.lineTo(-5 * scale, 50 * scale);
  context.lineTo(-5 * scale, 40 * scale);
  context.bezierCurveTo(-5 * scale, 40 * scale, 0, 42 * scale, 5 * scale, 40 * scale);
  context.lineTo(5 * scale, 50 * scale);
  context.lineTo(15 * scale, 50 * scale);
  context.lineTo(15 * scale, 40 * scale);
  context.bezierCurveTo(30 * scale, 35 * scale, 45 * scale, 15 * scale, 45 * scale, -5 * scale);
  context.bezierCurveTo(45 * scale, -25 * scale, 30 * scale, -50 * scale, 0, -50 * scale);
  context.closePath();
  context.fill();

  context.beginPath();
  context.moveTo(-40 * scale, -15 * scale);
  context.bezierCurveTo(-55 * scale, -20 * scale, -60 * scale, -10 * scale, -55 * scale, 0);
  context.bezierCurveTo(-50 * scale, 10 * scale, -40 * scale, 5 * scale, -35 * scale, -5 * scale);
  context.bezierCurveTo(-32 * scale, -12 * scale, -35 * scale, -15 * scale, -40 * scale, -15 * scale);
  context.closePath();
  context.fill();

  context.beginPath();
  context.moveTo(40 * scale, -15 * scale);
  context.bezierCurveTo(55 * scale, -20 * scale, 60 * scale, -10 * scale, 55 * scale, 0);
  context.bezierCurveTo(50 * scale, 10 * scale, 40 * scale, 5 * scale, 35 * scale, -5 * scale);
  context.bezierCurveTo(32 * scale, -12 * scale, 35 * scale, -15 * scale, 40 * scale, -15 * scale);
  context.closePath();
  context.fill();

  context.strokeStyle = "#ff4d4d";
  context.lineWidth = 3 * scale;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(-15 * scale, -45 * scale);
  context.quadraticCurveTo(-25 * scale, -55 * scale, -30 * scale, -52 * scale);
  context.stroke();
  context.beginPath();
  context.moveTo(15 * scale, -45 * scale);
  context.quadraticCurveTo(25 * scale, -55 * scale, 30 * scale, -52 * scale);
  context.stroke();

  const eyeHeight = Math.max(0.8, (1 - blink) * 6) * scale;
  for (const side of [-1, 1]) {
    context.fillStyle = "#050810";
    context.beginPath();
    context.ellipse(side * 15 * scale, -25 * scale, 6 * scale, eyeHeight, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = state === "error" ? "#ffb09c" : "#00e5cc";
    context.beginPath();
    context.ellipse(
      side * 15 * scale + 1 * scale,
      -26 * scale,
      2.5 * scale,
      Math.max(0.4, eyeHeight * 0.42),
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
  }

  const mouthOpen = Math.min(1, audioLevel * 0.76 + visemeOpen * 0.74);
  const mouthWidth = (13 + visemeWide * 5 - mouthOpen * 1.5) * scale;
  const mouthHeight = (1.5 + mouthOpen * 10) * scale;
  context.fillStyle = "#050810";
  roundedRect(-mouthWidth / 2, -4 * scale - mouthHeight / 2, mouthWidth, mouthHeight, mouthHeight / 2);
  context.fill();

  context.restore();
}

function inspectFirstFrame(): { nonBackground: boolean; foregroundPixels: number } {
  const width = canvas.width;
  const height = canvas.height;
  const pixels = context.getImageData(0, 0, width, height).data;
  let foregroundPixels = 0;
  const step = Math.max(4, Math.floor(Math.min(width, height) / 120));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      if (red > 70 || green > 70 || blue > 90) foregroundPixels += 1;
    }
  }
  return { nonBackground: foregroundPixels > 100, foregroundPixels };
}

function reportRenderer(firstFrame?: { nonBackground: boolean; foregroundPixels: number }): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "renderer.status",
      ready: firstFrameReported,
      renderedFrames,
      ...(firstFrame ? { firstFrame } : {}),
    }),
  );
}

function draw(now: number, forced = false): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(320, Math.round(rect.width * dpr));
  const height = Math.max(240, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const delta = Math.min(50, now - lastTime);
  lastTime = now;
  const audioScheduled = advanceAudioEnvelope(now);
  audioLevel += (audioTarget - audioLevel) * Math.min(1, delta / 58);
  if (!audioScheduled) audioTarget *= Math.pow(0.965, delta / 16.7);
  expressionPulse += (expressionTarget - expressionPulse) * Math.min(1, delta / 180);
  expressionTarget *= Math.pow(0.99, delta / 16.7);

  if (blinkStartedAt === null && now >= nextBlinkAt) blinkStartedAt = now;
  if (blinkStartedAt !== null) {
    const blinkAge = now - blinkStartedAt;
    if (blinkAge < 170) {
      blink = Math.sin((blinkAge / 170) * Math.PI);
    } else {
      blink = 0;
      blinkStartedAt = null;
      nextBlinkAt = now + 2700 + ((renderedFrames * 7919) % 1900);
    }
  }

  drawBackdrop(width, height);
  const scale = Math.min(width / 140, height / 140);
  const float = Math.sin(now * 0.0012) * 3 * scale;
  const cx = width / 2;
  const cy = height / 2 + float;
  drawFace(cx, cy, scale);
  renderedFrames += 1;

  if (!firstFrameReported && renderedFrames >= 2) {
    const firstFrame = inspectFirstFrame();
    firstFrameReported = firstFrame.nonBackground;
    reportRenderer(firstFrame);
  } else if (now >= reportAt) {
    reportAt = now + 1000;
    reportRenderer();
  }
  if (!forced) requestAnimationFrame(draw);
}

setState("idle");
requestAnimationFrame(draw);
