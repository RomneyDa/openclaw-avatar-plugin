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
  visemeOpen = 0;
  visemeWide = 0;
  expressionPulse = 0;
  expressionTarget = 0;
  draw(performance.now(), true);
}

function decodePcmLevel(base64: string): number {
  const binary = atob(base64);
  receivedAudioEvents += 1;
  receivedAudioBytes += binary.length;
  for (let index = 0; index < binary.length; index += 1) {
    receivedAudioHash ^= BigInt(binary.charCodeAt(index));
    receivedAudioHash = BigInt.asUintN(64, receivedAudioHash * 0x100000001b3n);
  }
  const samples = Math.floor(binary.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 2) {
    const offset = index * 2;
    let sample = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.min(1, Math.max(0, (Math.sqrt(sum / Math.ceil(samples / 2)) - 0.012) * 5.8));
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
    audioTarget = decodePcmLevel(event.pcmBase64);
    setState("speaking");
  } else if (event.type === "visemes" && event.weights) {
    const weights = event.weights;
    visemeOpen = Math.min(
      1,
      (weights.aa ?? 0) + (weights.O ?? 0) * 0.9 + (weights.U ?? 0) * 0.72 + (weights.E ?? 0) * 0.45,
    );
    visemeWide = Math.min(1, (weights.E ?? 0) + (weights.I ?? 0) * 0.8 + (weights.SS ?? 0) * 0.55);
  } else if (event.type === "state" && event.state) {
    setState(event.state);
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

function glowCircle(x: number, y: number, radius: number, color: string, alpha: number): void {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color.replace("ALPHA", String(alpha)));
  gradient.addColorStop(1, color.replace("ALPHA", "0"));
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function drawBackdrop(width: number, height: number, time: number): void {
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#08091a");
  background.addColorStop(0.52, "#0f0b24");
  background.addColorStop(1, "#07141d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  glowCircle(width * 0.23, height * 0.32, width * 0.34, "rgba(87,77,255,ALPHA)", 0.19);
  glowCircle(width * 0.78, height * 0.66, width * 0.32, "rgba(255,82,114,ALPHA)", 0.14);
  context.save();
  context.globalAlpha = 0.13;
  context.strokeStyle = "#9a8cff";
  context.lineWidth = 1;
  const spacing = Math.max(42, width / 24);
  const shift = (time * 0.006) % spacing;
  for (let x = -height; x < width + height; x += spacing) {
    context.beginPath();
    context.moveTo(x + shift, 0);
    context.lineTo(x - height + shift, height);
    context.stroke();
  }
  context.restore();
}

function drawOrbit(cx: number, cy: number, scale: number, time: number): void {
  context.save();
  context.translate(cx, cy);
  context.rotate(Math.sin(time * 0.0002) * 0.07);
  context.strokeStyle = state === "error" ? "#ff476f66" : state === "listening" ? "#63efd066" : "#927cff50";
  context.lineWidth = 2 * scale;
  context.setLineDash([8 * scale, 14 * scale]);
  context.lineDashOffset = -time * 0.015;
  context.beginPath();
  context.ellipse(0, 0, 252 * scale, 220 * scale, -0.18, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  for (let index = 0; index < 3; index += 1) {
    const angle = time * 0.00025 * (index % 2 ? -1 : 1) + index * 2.1;
    const x = Math.cos(angle) * 248 * scale;
    const y = Math.sin(angle) * 216 * scale;
    context.fillStyle = index === 1 ? "#6ff3d2" : "#ff7580";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 16 * scale;
    context.beginPath();
    context.arc(x, y, 4.5 * scale, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawClaw(side: -1 | 1, cx: number, cy: number, scale: number, motion: number): void {
  context.save();
  context.translate(cx + side * 177 * scale, cy + 47 * scale + motion * 4 * scale);
  context.scale(side, 1);
  context.rotate(-0.1 - motion * 0.025);
  const gradient = context.createLinearGradient(-30 * scale, -60 * scale, 65 * scale, 70 * scale);
  gradient.addColorStop(0, "#ff9c7c");
  gradient.addColorStop(0.5, "#f35f70");
  gradient.addColorStop(1, "#a92c63");
  context.fillStyle = gradient;
  context.shadowColor = "#ff506966";
  context.shadowBlur = 30 * scale;
  context.beginPath();
  context.moveTo(-25 * scale, 54 * scale);
  context.bezierCurveTo(-61 * scale, 22 * scale, -56 * scale, -32 * scale, -18 * scale, -56 * scale);
  context.bezierCurveTo(9 * scale, -73 * scale, 33 * scale, -51 * scale, 21 * scale, -25 * scale);
  context.bezierCurveTo(49 * scale, -54 * scale, 80 * scale, -34 * scale, 68 * scale, -4 * scale);
  context.bezierCurveTo(54 * scale, 33 * scale, 17 * scale, 59 * scale, -25 * scale, 54 * scale);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "#ffd0ba66";
  context.lineWidth = 2 * scale;
  context.beginPath();
  context.moveTo(18 * scale, -24 * scale);
  context.quadraticCurveTo(31 * scale, -5 * scale, 12 * scale, 15 * scale);
  context.stroke();
  context.restore();
}

function drawFace(cx: number, cy: number, scale: number, time: number): void {
  const pulse = state === "speaking" ? audioLevel : state === "thinking" ? 0.3 + Math.sin(time * 0.004) * 0.15 : 0;
  context.save();
  context.translate(cx, cy);

  context.strokeStyle = "#e56f7866";
  context.lineWidth = 4 * scale;
  context.lineCap = "round";
  for (const side of [-1, 1]) {
    context.beginPath();
    context.moveTo(side * 72 * scale, -126 * scale);
    context.quadraticCurveTo(side * 104 * scale, -182 * scale, side * 132 * scale, -194 * scale);
    context.stroke();
    context.fillStyle = side === -1 ? "#6ff3d2" : "#ff7981";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 18 * scale;
    context.beginPath();
    context.arc(side * 134 * scale, -196 * scale, 7 * scale, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;

  const shell = context.createLinearGradient(-120 * scale, -140 * scale, 140 * scale, 150 * scale);
  shell.addColorStop(0, "#2d315d");
  shell.addColorStop(0.48, "#171a3a");
  shell.addColorStop(1, "#0d1027");
  context.fillStyle = shell;
  context.shadowColor = "#000a";
  context.shadowBlur = 54 * scale;
  roundedRect(-139 * scale, -145 * scale, 278 * scale, 292 * scale, 106 * scale);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "#ffffff1c";
  context.lineWidth = 2 * scale;
  context.stroke();

  const crown = context.createLinearGradient(0, -146 * scale, 0, -55 * scale);
  crown.addColorStop(0, "#ff817d");
  crown.addColorStop(1, "#bd396b");
  context.fillStyle = crown;
  context.beginPath();
  context.moveTo(-88 * scale, -124 * scale);
  context.quadraticCurveTo(-54 * scale, -167 * scale, 0, -145 * scale);
  context.quadraticCurveTo(54 * scale, -167 * scale, 88 * scale, -124 * scale);
  context.quadraticCurveTo(50 * scale, -99 * scale, 0, -108 * scale);
  context.quadraticCurveTo(-50 * scale, -99 * scale, -88 * scale, -124 * scale);
  context.fill();

  const visor = context.createLinearGradient(-92 * scale, -50 * scale, 92 * scale, 30 * scale);
  visor.addColorStop(0, "#10152c");
  visor.addColorStop(0.5, "#202954");
  visor.addColorStop(1, "#10152c");
  context.fillStyle = visor;
  context.shadowColor = state === "error" ? "#ff476f66" : "#6ff3d244";
  context.shadowBlur = (10 + pulse * 20) * scale;
  roundedRect(-103 * scale, -58 * scale, 206 * scale, 91 * scale, 42 * scale);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = state === "error" ? "#ff5d7b" : "#74ddcf80";
  context.lineWidth = 2 * scale;
  context.stroke();

  const eyeHeight = Math.max(1.5, (1 - blink) * 18) * scale;
  for (const side of [-1, 1]) {
    context.fillStyle = state === "error" ? "#ff5c78" : "#d8fff8";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 14 * scale;
    roundedRect(side * 49 * scale - 25 * scale, -22 * scale - eyeHeight / 2, 50 * scale, eyeHeight, 12 * scale);
    context.fill();
  }
  context.shadowBlur = 0;

  const mouthOpen = Math.min(1, audioLevel * 0.76 + visemeOpen * 0.74);
  const mouthWidth = (66 + visemeWide * 28 - mouthOpen * 7) * scale;
  const mouthHeight = (8 + mouthOpen * 43) * scale;
  context.fillStyle = "#090916";
  context.shadowColor = "#ff617c88";
  context.shadowBlur = (8 + mouthOpen * 25) * scale;
  roundedRect(-mouthWidth / 2, 66 * scale - mouthHeight / 2, mouthWidth, mouthHeight, mouthHeight / 2);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "#ff8394aa";
  context.lineWidth = 2 * scale;
  context.stroke();
  if (mouthOpen > 0.28) {
    context.fillStyle = "#ff7386";
    roundedRect(-mouthWidth * 0.3, (69 + mouthOpen * 8) * scale, mouthWidth * 0.6, 5 * scale, 3 * scale);
    context.fill();
  }

  context.strokeStyle = "#ffffff12";
  context.lineWidth = 2 * scale;
  context.beginPath();
  context.arc(0, 0, 121 * scale, -2.6, -0.55);
  context.stroke();
  context.restore();
}

function drawStateGlyph(cx: number, cy: number, scale: number, time: number): void {
  context.save();
  context.translate(cx, cy);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${13 * scale}px ui-sans-serif, system-ui`;
  context.letterSpacing = `${2.2 * scale}px`;
  context.fillStyle = "#d9d7f2";
  const label = stateLabels[state];
  const width = context.measureText(label).width + 40 * scale;
  context.fillStyle = "#101329cc";
  roundedRect(-width / 2, -17 * scale, width, 34 * scale, 17 * scale);
  context.fill();
  context.strokeStyle = "#ffffff18";
  context.stroke();
  context.fillStyle = state === "error" ? "#ff7990" : state === "listening" ? "#7ef1d6" : "#e6e3ff";
  context.fillText(label, 1 * scale, 1 * scale);
  if (state === "thinking") {
    for (let index = 0; index < 3; index += 1) {
      const phase = (time * 0.004 + index * 1.2) % 3.6;
      context.globalAlpha = 0.25 + Math.max(0, Math.sin(phase)) * 0.75;
      context.beginPath();
      context.arc((index - 1) * 14 * scale, 36 * scale, 3 * scale, 0, Math.PI * 2);
      context.fill();
    }
  }
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
  audioLevel += (audioTarget - audioLevel) * Math.min(1, delta / 58);
  audioTarget *= Math.pow(0.965, delta / 16.7);
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

  drawBackdrop(width, height, now);
  const scale = Math.min(width / 900, height / 620);
  const float = Math.sin(now * 0.0012) * 7 * scale;
  const cx = width / 2;
  const cy = height / 2 + 10 * scale + float;
  drawOrbit(cx, cy, scale, now);
  drawClaw(-1, cx, cy, scale, Math.sin(now * 0.0015));
  drawClaw(1, cx, cy, scale, Math.sin(now * 0.0015));
  drawFace(cx, cy, scale, now);
  drawStateGlyph(cx, cy + 202 * scale, scale, now);
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
