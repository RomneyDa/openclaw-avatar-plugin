// src/demo.ts
import { execFile } from "node:child_process";

// src/renderer.ts
import { fileURLToPath } from "node:url";

// src/adapter.ts
function createAvatarMediaConsumer(session) {
  return {
    start: ({ sessionId, video, initialState }) => {
      session.start({ sessionId, video });
      if (initialState && initialState !== "idle") session.state(initialState, 0);
    },
    audio: (pcm, ptsMs) => session.audio(pcm, ptsMs),
    visemes: (weights, ptsMs) => session.visemes(weights, ptsMs),
    state: (state, ptsMs) => session.state(state, ptsMs),
    expression: (name, intensity, transitionMs, ptsMs) => session.expression(name, intensity, transitionMs, ptsMs),
    clear: (reason) => session.clear(reason),
    end: (reason) => session.end(reason)
  };
}

// src/browser-host.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
var CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};
function normalizeRouteBase(input) {
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : "";
}
function isLoopbackAddress(address) {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}
function serializeEvent(event) {
  if (event.type === "audio") {
    return JSON.stringify({
      ...event,
      pcm: void 0,
      pcmBase64: Buffer.from(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength).toString("base64")
    });
  }
  return JSON.stringify(event);
}
var AvatarBrowserHost = class {
  session;
  assetsPath;
  routeBase;
  token;
  maxTransportBufferedBytes;
  webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024
  });
  #server = null;
  #port = 0;
  #clientCounter = 0;
  #connectedClients = 0;
  #readyClients = 0;
  #sentEvents = 0;
  #sentAudioBytes = 0;
  #droppedTransportMedia = 0;
  #renderedFrames = 0;
  #firstFrameValidated = false;
  #rendererError = null;
  constructor(options) {
    this.session = options.session;
    this.assetsPath = options.assetsPath;
    this.routeBase = normalizeRouteBase(options.routeBase ?? "/plugins/avatar");
    this.token = options.token ?? randomBytes(24).toString("base64url");
    this.maxTransportBufferedBytes = options.maxTransportBufferedBytes ?? 1048576;
    this.webSockets.on("connection", (socket) => this.onConnection(socket));
  }
  get rendererPath() {
    return `${this.routeBase}/?token=${encodeURIComponent(this.token)}`;
  }
  get rendererUrl() {
    if (!this.#port) throw new Error("standalone avatar browser host is not running");
    return `http://127.0.0.1:${this.#port}${this.rendererPath}`;
  }
  async startStandalone(port = 0) {
    if (this.#server) return;
    this.assertAssets();
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).then((handled) => {
        if (!handled && !socket.destroyed) socket.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("avatar browser host failed to bind a loopback port");
    }
    this.#server = server;
    this.#port = address.port;
  }
  async handleRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!this.matches(url.pathname)) return false;
    this.applySecurityHeaders(response);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.statusCode = 403;
      response.end("loopback only");
      return true;
    }
    if (!this.validToken(url.searchParams.get("token"))) {
      response.statusCode = 401;
      response.end("unauthorized");
      return true;
    }
    const suffix = this.suffix(url.pathname);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.end();
      return true;
    }
    if (suffix === "/health") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(this.snapshot()));
      return true;
    }
    if (suffix === "/" || suffix === "") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(this.indexHtml());
      return true;
    }
    const asset = suffix === "/client.js" ? "client.js" : suffix === "/styles.css" ? "styles.css" : null;
    if (!asset) {
      response.statusCode = 404;
      response.end("not found");
      return true;
    }
    const filename = path.join(this.assetsPath, asset);
    if (!fs.existsSync(filename)) {
      response.statusCode = 503;
      response.end("avatar assets unavailable; run npm run build");
      return true;
    }
    response.setHeader("content-type", CONTENT_TYPES[path.extname(asset)] ?? "application/octet-stream");
    response.setHeader("content-length", fs.statSync(filename).size);
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filename).pipe(response);
    return true;
  }
  async handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (this.suffix(url.pathname) !== "/stream") return false;
    if (!isLoopbackAddress(request.socket.remoteAddress) || !this.validToken(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    this.webSockets.handleUpgrade(request, socket, head, (client) => {
      this.webSockets.emit("connection", client, request);
    });
    return true;
  }
  snapshot() {
    return {
      runningStandalone: Boolean(this.#server),
      port: this.#port || null,
      connectedClients: this.#connectedClients,
      readyClients: this.#readyClients,
      sentEvents: this.#sentEvents,
      sentAudioBytes: this.#sentAudioBytes,
      droppedTransportMedia: this.#droppedTransportMedia,
      renderedFrames: this.#renderedFrames,
      firstFrameValidated: this.#firstFrameValidated,
      rendererError: this.#rendererError,
      session: this.session.snapshot()
    };
  }
  async stop() {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    for (const client of this.webSockets.clients) client.close(1001, "avatar host stopped");
    await new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
  }
  onConnection(socket) {
    const id = `browser-${++this.#clientCounter}`;
    this.#connectedClients += 1;
    let ready = false;
    const unsubscribe = this.session.subscribe(id, (event) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("renderer transport disconnected");
      if (socket.bufferedAmount > this.maxTransportBufferedBytes && (event.type === "audio" || event.type === "visemes")) {
        this.#droppedTransportMedia += 1;
        return;
      }
      socket.send(serializeEvent(event));
      this.#sentEvents += 1;
      if (event.type === "audio") this.#sentAudioBytes += event.pcm.byteLength;
    });
    socket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        snapshot: this.session.snapshot()
      })
    );
    socket.on("message", (data, binary) => {
      if (binary || Buffer.byteLength(data) > 8 * 1024) return;
      try {
        const status = JSON.parse(String(data));
        if (status.type !== "renderer.status") return;
        const nextReady = status.ready === true;
        if (ready !== nextReady) {
          ready = nextReady;
          this.#readyClients += ready ? 1 : -1;
        }
        if (typeof status.renderedFrames === "number" && Number.isSafeInteger(status.renderedFrames)) {
          this.#renderedFrames = Math.max(this.#renderedFrames, status.renderedFrames);
        }
        if (typeof status.firstFrame === "object" && status.firstFrame !== null) {
          const firstFrame = status.firstFrame;
          this.#firstFrameValidated = firstFrame.nonBackground === true && typeof firstFrame.foregroundPixels === "number" && firstFrame.foregroundPixels > 100;
        }
        this.#rendererError = typeof status.error === "string" ? status.error.slice(0, 512) : null;
      } catch {
      }
    });
    socket.once("close", () => {
      unsubscribe();
      this.#connectedClients -= 1;
      if (ready) this.#readyClients -= 1;
    });
    socket.once("error", () => socket.close());
  }
  assertAssets() {
    for (const asset of ["client.js", "styles.css"]) {
      if (!fs.existsSync(path.join(this.assetsPath, asset))) {
        throw new Error(`avatar browser asset missing: ${asset}; run npm run build`);
      }
    }
  }
  matches(pathname) {
    return pathname === this.routeBase || pathname.startsWith(`${this.routeBase}/`);
  }
  suffix(pathname) {
    if (!this.matches(pathname)) return "";
    return pathname.slice(this.routeBase.length) || "/";
  }
  validToken(value) {
    if (!value) return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(value);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
  applySecurityHeaders(response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "SAMEORIGIN");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    );
  }
  indexHtml() {
    const token = encodeURIComponent(this.token);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="color-scheme" content="light">
    <title>OpenClaw Avatar</title>
    <link rel="stylesheet" href="${this.routeBase}/styles.css?token=${token}">
  </head>
  <body>
    <main id="stage" aria-label="OpenClaw animated avatar">
      <canvas id="avatar" width="1280" height="720"></canvas>
      <section id="chrome" aria-live="polite">
        <div class="brand"><span class="signal"></span><span>OPENCLAW // AVATAR</span></div>
        <div id="status"><span class="status-dot"></span><span id="status-label">CONNECTING</span></div>
      </section>
      <div id="error" hidden></div>
    </main>
    <script type="module" src="${this.routeBase}/client.js?token=${token}"></script>
  </body>
</html>`;
  }
};

// src/events.ts
var CANONICAL_VISEMES = [
  "sil",
  "PP",
  "FF",
  "TH",
  "DD",
  "kk",
  "CH",
  "SS",
  "nn",
  "RR",
  "aa",
  "E",
  "I",
  "O",
  "U"
];
var AVATAR_AUDIO_FORMAT = {
  encoding: "pcm16le",
  sampleRateHz: 24e3,
  channels: 1
};
var VISEMES = new Set(CANONICAL_VISEMES);
var STATES = /* @__PURE__ */ new Set(["idle", "listening", "thinking", "speaking", "error"]);
var CLEAR_REASONS = /* @__PURE__ */ new Set(["barge-in", "cancel", "replace", "hangup", "error"]);
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
function finite(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be finite and from ${minimum} to ${maximum}`);
  }
  return value;
}
function boundedString(value, label, maximum = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}
function generation(value) {
  return integer(value, "generation", 0, 2147483647);
}
function pts(value, options) {
  return finite(value, "ptsMs", 0, options.maxPtsMs ?? 864e5);
}
function validateAvatarEvent(value, options = {}) {
  const event = record(value, "avatar event");
  const type = event.type;
  if (typeof type !== "string") {
    throw new TypeError("avatar event type is required");
  }
  if (type === "session.start") {
    const audio = record(event.audio, "audio format");
    const video = record(event.video, "video format");
    if (audio.encoding !== AVATAR_AUDIO_FORMAT.encoding || audio.sampleRateHz !== AVATAR_AUDIO_FORMAT.sampleRateHz || audio.channels !== AVATAR_AUDIO_FORMAT.channels) {
      throw new TypeError("audio format must be PCM16LE, 24000 Hz, mono");
    }
    return {
      type,
      sessionId: boundedString(event.sessionId, "sessionId"),
      generation: generation(event.generation),
      audio: AVATAR_AUDIO_FORMAT,
      video: {
        width: integer(video.width, "video.width", 16, 4096),
        height: integer(video.height, "video.height", 16, 4096),
        frameRate: finite(video.frameRate, "video.frameRate", 1, 120)
      }
    };
  }
  if (type === "audio") {
    if (!(event.pcm instanceof Uint8Array)) {
      throw new TypeError("audio.pcm must be a Uint8Array");
    }
    const max = options.maxAudioChunkBytes ?? 96e3;
    if (event.pcm.byteLength === 0 || event.pcm.byteLength > max || event.pcm.byteLength % 2 !== 0) {
      throw new TypeError(`audio.pcm must contain 1 to ${max / 2} complete PCM16LE samples`);
    }
    return {
      type,
      generation: generation(event.generation),
      sequence: integer(event.sequence, "sequence"),
      ptsMs: pts(event.ptsMs, options),
      pcm: event.pcm
    };
  }
  if (type === "visemes") {
    const input = record(event.weights, "viseme weights");
    const weights = {};
    for (const [name, weight] of Object.entries(input)) {
      if (!VISEMES.has(name)) {
        throw new TypeError(`unknown canonical viseme: ${name}`);
      }
      weights[name] = finite(weight, `viseme.${name}`, 0, 1);
    }
    return {
      type,
      generation: generation(event.generation),
      sequence: integer(event.sequence, "sequence"),
      ptsMs: pts(event.ptsMs, options),
      weights
    };
  }
  if (type === "state") {
    if (typeof event.state !== "string" || !STATES.has(event.state)) {
      throw new TypeError("invalid avatar state");
    }
    return {
      type,
      generation: generation(event.generation),
      ptsMs: pts(event.ptsMs, options),
      state: event.state
    };
  }
  if (type === "expression") {
    return {
      type,
      generation: generation(event.generation),
      ptsMs: pts(event.ptsMs, options),
      name: boundedString(event.name, "expression.name", 64),
      intensity: finite(event.intensity, "expression.intensity", 0, 1),
      transitionMs: finite(event.transitionMs, "expression.transitionMs", 0, 1e4)
    };
  }
  if (type === "clear") {
    if (typeof event.reason !== "string" || !CLEAR_REASONS.has(event.reason)) {
      throw new TypeError("invalid clear reason");
    }
    return {
      type,
      generation: generation(event.generation),
      reason: event.reason
    };
  }
  if (type === "session.end") {
    return {
      type,
      generation: generation(event.generation),
      reason: boundedString(event.reason, "session.end reason", 256)
    };
  }
  throw new TypeError(`unknown avatar event type: ${type}`);
}
function isAvatarMediaEvent(event) {
  return event.type === "audio" || event.type === "visemes";
}

// src/session.ts
var SubscriberQueue = class {
  id;
  handler;
  options;
  metrics;
  onError;
  queue = [];
  queuedMediaBytes = 0;
  active = true;
  draining = false;
  constructor(params) {
    this.id = params.id;
    this.handler = params.handler;
    this.options = params.options;
    this.metrics = params.metrics;
    this.onError = params.onError;
  }
  enqueue(event) {
    if (!this.active) return false;
    const mediaBytes = event.type === "audio" ? event.pcm.byteLength : event.type === "visemes" ? 1 : 0;
    if (isAvatarMediaEvent(event)) {
      const mediaEvents = this.queue.reduce(
        (count, queued) => count + (isAvatarMediaEvent(queued.event) ? 1 : 0),
        0
      );
      if (mediaEvents >= this.options.maxSubscriberMediaEvents || this.queuedMediaBytes + mediaBytes > this.options.maxSubscriberMediaBytes) {
        this.metrics.droppedMediaEvents += 1;
        this.metrics.droppedMediaBytes += event.type === "audio" ? event.pcm.byteLength : 0;
        return false;
      }
    } else {
      if (event.type === "clear" || event.type === "session.end") {
        const retained = [];
        for (const queued of this.queue) {
          if (queued.event.generation < event.generation && isAvatarMediaEvent(queued.event)) {
            this.metrics.droppedMediaEvents += 1;
            this.metrics.droppedMediaBytes += queued.event.type === "audio" ? queued.event.pcm.byteLength : 0;
            this.queuedMediaBytes -= queued.mediaBytes;
          } else {
            retained.push(queued);
          }
        }
        this.queue = retained;
      }
      const controls = this.queue.reduce(
        (count, queued) => count + (isAvatarMediaEvent(queued.event) ? 0 : 1),
        0
      );
      if (controls >= this.options.maxSubscriberControlEvents) {
        this.fail(new Error(`subscriber control queue exceeded ${this.options.maxSubscriberControlEvents} events`));
        return false;
      }
    }
    this.queue.push({ event, mediaBytes });
    this.queuedMediaBytes += mediaBytes;
    this.updateDepthMetrics();
    void this.drain();
    return true;
  }
  stop() {
    this.active = false;
    this.queue = [];
    this.queuedMediaBytes = 0;
    this.updateDepthMetrics();
  }
  async drain() {
    if (this.draining || !this.active) return;
    this.draining = true;
    try {
      while (this.active) {
        const entry = this.queue.shift();
        if (!entry) break;
        this.queuedMediaBytes -= entry.mediaBytes;
        this.updateDepthMetrics();
        await this.handler(entry.event);
        this.metrics.deliveredEvents += 1;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.draining = false;
      if (this.active && this.queue.length > 0) void this.drain();
    }
  }
  fail(error) {
    if (!this.active) return;
    this.metrics.subscriberFailures += 1;
    this.stop();
    this.onError?.(this.id, error);
  }
  updateDepthMetrics() {
    this.metrics.queueDepth = Math.max(0, this.metrics.queueDepth);
    this.metrics.queuedMediaBytes = Math.max(0, this.metrics.queuedMediaBytes);
  }
};
var AvatarSession = class {
  options;
  subscribers = /* @__PURE__ */ new Map();
  metrics = {
    generation: 0,
    currentState: "idle",
    subscribers: 0,
    inputAudioBytes: 0,
    visemeFrames: 0,
    controlEvents: 0,
    deliveredEvents: 0,
    droppedMediaEvents: 0,
    droppedMediaBytes: 0,
    subscriberFailures: 0,
    queueDepth: 0,
    queuedMediaBytes: 0
  };
  #active = false;
  #sessionId = null;
  #sequence = 0;
  #video = { width: 1280, height: 720, frameRate: 30 };
  constructor(options = {}) {
    this.options = {
      maxAudioChunkBytes: options.maxAudioChunkBytes ?? 96e3,
      maxSubscriberMediaBytes: options.maxSubscriberMediaBytes ?? 1048576,
      maxSubscriberMediaEvents: options.maxSubscriberMediaEvents ?? 128,
      maxSubscriberControlEvents: options.maxSubscriberControlEvents ?? 32,
      ...options.onSubscriberError ? { onSubscriberError: options.onSubscriberError } : {}
    };
  }
  subscribe(id, handler) {
    if (!id || this.subscribers.has(id)) throw new Error(`avatar subscriber id is invalid or duplicated: ${id}`);
    const subscriber = new SubscriberQueue({
      id,
      handler,
      options: this.options,
      metrics: this.metrics,
      ...this.options.onSubscriberError ? { onError: this.options.onSubscriberError } : {}
    });
    this.subscribers.set(id, subscriber);
    this.metrics.subscribers = this.subscribers.size;
    return () => {
      subscriber.stop();
      this.subscribers.delete(id);
      this.recalculateQueueMetrics();
    };
  }
  start(params) {
    if (this.#active) throw new Error("avatar session is already active");
    this.#active = true;
    this.#sessionId = params.sessionId;
    this.#sequence = 0;
    if (params.generation !== void 0) this.metrics.generation = params.generation;
    if (params.video) this.#video = { ...params.video };
    this.metrics.currentState = "idle";
    this.publish({
      type: "session.start",
      sessionId: params.sessionId,
      generation: this.metrics.generation,
      audio: AVATAR_AUDIO_FORMAT,
      video: this.#video
    });
  }
  audio(pcm, ptsMs) {
    this.requireActive();
    if (this.metrics.currentState !== "speaking") this.state("speaking", ptsMs);
    this.metrics.inputAudioBytes += pcm.byteLength;
    return this.publish({
      type: "audio",
      generation: this.metrics.generation,
      sequence: this.#sequence++,
      ptsMs,
      pcm: Uint8Array.from(pcm)
    });
  }
  audioFromSource(params) {
    this.requireActive();
    if (params.generation !== this.metrics.generation) return false;
    this.metrics.currentState = "speaking";
    this.metrics.inputAudioBytes += params.pcm.byteLength;
    this.#sequence = Math.max(this.#sequence, params.sequence + 1);
    return this.publish({ type: "audio", ...params, pcm: Uint8Array.from(params.pcm) });
  }
  visemes(weights, ptsMs) {
    this.requireActive();
    this.metrics.visemeFrames += 1;
    return this.publish({
      type: "visemes",
      generation: this.metrics.generation,
      sequence: this.#sequence++,
      ptsMs,
      weights
    });
  }
  state(state, ptsMs) {
    this.requireActive();
    this.metrics.currentState = state;
    this.publish({ type: "state", generation: this.metrics.generation, ptsMs, state });
  }
  stateFromSource(state, ptsMs, generation2) {
    this.requireActive();
    if (generation2 !== this.metrics.generation) return false;
    this.metrics.currentState = state;
    this.publish({ type: "state", generation: generation2, ptsMs, state });
    return true;
  }
  expression(name, intensity, transitionMs, ptsMs) {
    this.requireActive();
    this.publish({
      type: "expression",
      generation: this.metrics.generation,
      ptsMs,
      name,
      intensity,
      transitionMs
    });
  }
  clear(reason) {
    this.requireActive();
    this.metrics.generation += 1;
    this.#sequence = 0;
    this.publish({ type: "clear", generation: this.metrics.generation, reason });
    return this.metrics.generation;
  }
  clearFromSource(reason, generation2) {
    this.requireActive();
    if (generation2 <= this.metrics.generation) return false;
    this.metrics.generation = generation2;
    this.#sequence = 0;
    this.publish({ type: "clear", generation: generation2, reason });
    return true;
  }
  end(reason) {
    if (!this.#active) return;
    this.clear(reason === "error" ? "error" : "hangup");
    this.metrics.currentState = reason === "error" ? "error" : "idle";
    this.publish({ type: "session.end", generation: this.metrics.generation, reason });
    this.#active = false;
    this.#sessionId = null;
  }
  endFromSource(reason, generation2) {
    if (!this.#active || generation2 !== this.metrics.generation) return false;
    this.metrics.currentState = reason === "error" ? "error" : "idle";
    this.publish({ type: "session.end", generation: generation2, reason });
    this.#active = false;
    this.#sessionId = null;
    return true;
  }
  snapshot() {
    this.recalculateQueueMetrics();
    return { ...this.metrics, active: this.#active, sessionId: this.#sessionId };
  }
  publish(input) {
    const event = validateAvatarEvent(input, { maxAudioChunkBytes: this.options.maxAudioChunkBytes });
    if (!isAvatarMediaEvent(event)) this.metrics.controlEvents += 1;
    let accepted = false;
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.active) {
        this.subscribers.delete(id);
        continue;
      }
      accepted = subscriber.enqueue(event) || accepted;
    }
    this.metrics.subscribers = this.subscribers.size;
    this.recalculateQueueMetrics();
    return accepted;
  }
  recalculateQueueMetrics() {
    let queueDepth = 0;
    let queuedMediaBytes = 0;
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.active) {
        this.subscribers.delete(id);
        continue;
      }
      queueDepth += subscriber.queue.length;
      queuedMediaBytes += subscriber.queuedMediaBytes;
    }
    this.metrics.subscribers = this.subscribers.size;
    this.metrics.queueDepth = queueDepth;
    this.metrics.queuedMediaBytes = queuedMediaBytes;
  }
  requireActive() {
    if (!this.#active) throw new Error("avatar session is not active");
  }
};

// src/renderer.ts
function createAvatarRenderer(options = {}) {
  const session = new AvatarSession(options);
  const host = new AvatarBrowserHost({
    session,
    assetsPath: options.assetsPath ?? fileURLToPath(new URL("../browser/", import.meta.url)),
    routeBase: options.routeBase ?? "/avatar",
    ...options.token ? { token: options.token } : {},
    ...options.maxTransportBufferedBytes ? { maxTransportBufferedBytes: options.maxTransportBufferedBytes } : {}
  });
  const consumer2 = createAvatarMediaConsumer(session);
  return {
    consumer: consumer2,
    start: () => host.startStandalone(options.port ?? 0),
    async stop() {
      consumer2.end("renderer-stopped");
      await host.stop();
    },
    get rendererUrl() {
      return host.rendererUrl;
    },
    snapshot: () => host.snapshot()
  };
}

// src/demo.ts
var renderer = createAvatarRenderer();
await renderer.start();
var { consumer } = renderer;
consumer.start({
  sessionId: "synthetic-demo",
  video: { width: 1280, height: 720, frameRate: 30 },
  initialState: "listening"
});
console.log(`OpenClaw Avatar demo: ${renderer.rendererUrl}`);
if (process.argv.includes("--open")) {
  execFile("open", [renderer.rendererUrl], () => {
  });
}
var sampleOffset = 0;
var elapsedMs = 0;
var phase = "listening";
var phaseStarted = Date.now();
var timer = setInterval(() => {
  const now = Date.now();
  const phaseAge = now - phaseStarted;
  if (phase === "listening" && phaseAge > 1600) {
    phase = "thinking";
    phaseStarted = now;
    consumer.state("thinking", elapsedMs);
  } else if (phase === "thinking" && phaseAge > 1200) {
    phase = "speaking";
    phaseStarted = now;
    consumer.state("speaking", elapsedMs);
  } else if (phase === "speaking" && phaseAge > 5600) {
    consumer.clear("cancel");
    phase = "listening";
    phaseStarted = now;
    consumer.state("listening", 0);
    elapsedMs = 0;
    sampleOffset = 0;
  }
  if (phase !== "speaking") return;
  const samples = 480;
  const pcm = Buffer.alloc(samples * 2);
  let envelopeSum = 0;
  for (let index = 0; index < samples; index += 1) {
    const time = (sampleOffset + index) / 24e3;
    const syllable = Math.pow(Math.max(0, Math.sin(Math.PI * 3.1 * time)), 0.55);
    const phrase = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, (phaseAge - 1200) / 4400));
    const envelope = syllable * phrase;
    envelopeSum += envelope;
    const voice = Math.sin(2 * Math.PI * 118 * time) * 0.5 + Math.sin(2 * Math.PI * 236 * time) * 0.22 + Math.sin(2 * Math.PI * 590 * time) * 0.1;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, voice * envelope)) * 26e3), index * 2);
  }
  const openness = Math.min(1, envelopeSum / samples * 1.4);
  consumer.visemes({ aa: openness, E: (1 - openness) * 0.35, sil: 1 - openness }, elapsedMs);
  consumer.audio(pcm, elapsedMs);
  sampleOffset += samples;
  elapsedMs += 20;
}, 20);
var shutdown = async () => {
  clearInterval(timer);
  consumer.end("demo-stopped");
  await renderer.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
//# sourceMappingURL=demo.mjs.map
