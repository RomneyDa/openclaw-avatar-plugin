import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AvatarEvent } from "./events.js";
import type { AvatarSession } from "./session.js";

export type AvatarBrowserHostOptions = {
  session: AvatarSession;
  assetsPath: string;
  talk?: AvatarBrowserTalkController;
  routeBase?: string;
  token?: string;
  maxTransportBufferedBytes?: number;
};

export type AvatarBrowserTalkController = {
  start: () => Promise<{ sessionId: string }>;
  appendAudio: (params: { sessionId: string; audioBase64: string; timestamp: number }) => Promise<void>;
  cancelOutput: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
};

type ClientStatus = {
  type?: unknown;
  ready?: unknown;
  firstFrame?: unknown;
  renderedFrames?: unknown;
  error?: unknown;
};

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function normalizeRouteBase(input: string): string {
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : "";
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

function serializeEvent(event: AvatarEvent): string {
  if (event.type === "audio") {
    return JSON.stringify({
      ...event,
      pcm: undefined,
      pcmBase64: Buffer.from(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength).toString("base64"),
    });
  }
  return JSON.stringify(event);
}

export class AvatarBrowserHost {
  readonly session: AvatarSession;
  readonly assetsPath: string;
  readonly talk: AvatarBrowserTalkController | undefined;
  readonly routeBase: string;
  readonly token: string;
  readonly maxTransportBufferedBytes: number;
  readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
  });
  #server: Server | null = null;
  #port = 0;
  #clientCounter = 0;
  #connectedClients = 0;
  #readyClients = 0;
  #sentEvents = 0;
  #sentAudioBytes = 0;
  #droppedTransportMedia = 0;
  #renderedFrames = 0;
  #firstFrameValidated = false;
  #rendererError: string | null = null;

  constructor(options: AvatarBrowserHostOptions) {
    this.session = options.session;
    this.assetsPath = options.assetsPath;
    this.talk = options.talk;
    this.routeBase = normalizeRouteBase(options.routeBase ?? "/plugins/avatar");
    this.token = options.token ?? randomBytes(24).toString("base64url");
    this.maxTransportBufferedBytes = options.maxTransportBufferedBytes ?? 1_048_576;
    this.webSockets.on("connection", (socket) => this.onConnection(socket));
  }

  get rendererPath(): string {
    return `${this.routeBase}/?token=${encodeURIComponent(this.token)}`;
  }

  get rendererUrl(): string {
    if (!this.#port) throw new Error("standalone avatar browser host is not running");
    return `http://127.0.0.1:${this.#port}${this.rendererPath}`;
  }

  async startStandalone(port = 0): Promise<void> {
    if (this.#server) return;
    this.assertAssets();
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).then((handled) => {
        if (!handled && !socket.destroyed) socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
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

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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
    if (request.method === "POST" && suffix.startsWith("/talk/")) {
      return await this.handleTalkRequest(request, response, suffix.slice("/talk".length));
    }
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
      const standaloneRequest = this.#port > 0 && request.socket.localPort === this.#port;
      response.end(this.indexHtml(Boolean(this.talk) && !standaloneRequest));
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

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
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
      session: this.session.snapshot(),
    };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    for (const client of this.webSockets.clients) client.close(1001, "avatar host stopped");
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }

  private onConnection(socket: WebSocket): void {
    const id = `browser-${++this.#clientCounter}`;
    this.#connectedClients += 1;
    let ready = false;
    const unsubscribe = this.session.subscribe(id, (event) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("renderer transport disconnected");
      if (
        socket.bufferedAmount > this.maxTransportBufferedBytes &&
        (event.type === "audio" || event.type === "visemes")
      ) {
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
        snapshot: this.session.snapshot(),
      }),
    );
    socket.on("message", (data, binary) => {
      if (binary || Buffer.byteLength(data as Buffer) > 8 * 1024) return;
      try {
        const status = JSON.parse(String(data)) as ClientStatus;
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
          const firstFrame = status.firstFrame as Record<string, unknown>;
          this.#firstFrameValidated =
            firstFrame.nonBackground === true &&
            typeof firstFrame.foregroundPixels === "number" &&
            firstFrame.foregroundPixels > 100;
        }
        this.#rendererError = typeof status.error === "string" ? status.error.slice(0, 512) : null;
      } catch {
        // Browser status is advisory and never contains media.
      }
    });
    socket.once("close", () => {
      unsubscribe();
      this.#connectedClients -= 1;
      if (ready) this.#readyClients -= 1;
    });
    socket.once("error", () => socket.close());
  }

  private assertAssets(): void {
    for (const asset of ["client.js", "styles.css"]) {
      if (!fs.existsSync(path.join(this.assetsPath, asset))) {
        throw new Error(`avatar browser asset missing: ${asset}; run npm run build`);
      }
    }
  }

  private async handleTalkRequest(
    request: IncomingMessage,
    response: ServerResponse,
    suffix: string,
  ): Promise<boolean> {
    if (!this.talk || (this.#port > 0 && request.socket.localPort === this.#port)) {
      response.statusCode = 404;
      response.end("talk input unavailable");
      return true;
    }
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("allow", "POST");
      response.end("method not allowed");
      return true;
    }
    try {
      const body = await this.readJsonBody(request);
      if (suffix === "/start") {
        const started = await this.talk.start();
        this.respondJson(response, 200, started);
        return true;
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId) throw new Error("sessionId is required");
      if (suffix === "/audio") {
        const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
        const timestamp = typeof body.timestamp === "number" ? body.timestamp : Number.NaN;
        if (!audioBase64 || audioBase64.length > 192_000 || !Number.isFinite(timestamp)) {
          throw new Error("valid audioBase64 and timestamp are required");
        }
        await this.talk.appendAudio({ sessionId, audioBase64, timestamp });
        this.respondJson(response, 200, { ok: true });
        return true;
      }
      if (suffix === "/cancel-output") {
        await this.talk.cancelOutput(sessionId);
        this.respondJson(response, 200, { ok: true });
        return true;
      }
      if (suffix === "/stop") {
        await this.talk.stop(sessionId);
        this.respondJson(response, 200, { ok: true });
        return true;
      }
      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message.slice(0, 240) : "talk request failed",
        }),
      );
    }
    return true;
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > 256 * 1024) throw new Error("request body is too large");
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON object required");
    }
    return parsed as Record<string, unknown>;
  }

  private respondJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  private matches(pathname: string): boolean {
    return pathname === this.routeBase || pathname.startsWith(`${this.routeBase}/`);
  }

  private suffix(pathname: string): string {
    if (!this.matches(pathname)) return "";
    return pathname.slice(this.routeBase.length) || "/";
  }

  private validToken(value: string | null): boolean {
    if (!value) return false;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(value);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader("cache-control", "no-store");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "SAMEORIGIN");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
  }

  private indexHtml(talkEnabled: boolean): string {
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
  <body data-talk-enabled="${talkEnabled ? "true" : "false"}" data-talk-path="/plugins/avatar/talk">
    <main id="stage" aria-label="OpenClaw animated avatar">
      <canvas id="avatar" width="1280" height="720"></canvas>
      <section id="chrome" aria-live="polite">
        <div class="brand"><span class="signal"></span><span>OPENCLAW // AVATAR</span></div>
        <div id="status"><span class="status-dot"></span><span id="status-label">CONNECTING</span></div>
      </section>
      <div id="error" hidden></div>
      <label id="talk-control" ${talkEnabled ? "" : "hidden"}>
        <input id="talk-toggle" type="checkbox" checked>
        <span id="talk-toggle-label">MIC ON</span>
      </label>
    </main>
    <script type="module" src="${this.routeBase}/client.js?token=${token}"></script>
  </body>
</html>`;
  }
}
