import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarBrowserHost } from "../src/browser-host.js";
import { AvatarSession } from "../src/session.js";

const hosts: AvatarBrowserHost[] = [];
afterEach(async () => Promise.all(hosts.splice(0).map((host) => host.stop())));

function assets(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-host-"));
  fs.writeFileSync(path.join(directory, "client.js"), "export {};\n");
  fs.writeFileSync(path.join(directory, "styles.css"), "body{}\n");
  return directory;
}

function connect(url: string): Promise<{
  socket: WebSocket;
  firstMessage: Promise<Record<string, unknown>>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const firstMessage = nextJson(socket);
    socket.once("open", () => resolve({ socket, firstMessage }));
    socket.once("error", reject);
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(String(data)))));
}

describe("AvatarBrowserHost", () => {
  it("serves only authenticated loopback requests with a strict CSP", async () => {
    const host = new AvatarBrowserHost({
      session: new AvatarSession(),
      assetsPath: assets(),
      token: "test-token",
    });
    hosts.push(host);
    await host.startStandalone(0);
    const url = new URL(host.rendererUrl);
    expect(url.hostname).toBe("127.0.0.1");
    const unauthorized = await fetch(`http://127.0.0.1:${url.port}/plugins/avatar/`);
    expect(unauthorized.status).toBe(401);
    const page = await fetch(host.rendererUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    expect(await page.text()).toContain("OpenClaw Avatar");
    await expect(connect(`ws://127.0.0.1:${url.port}/plugins/avatar/stream?token=wrong`)).rejects.toThrow();
  });

  it("delivers canonical audio as exact base64 and records validated first-frame readiness", async () => {
    const session = new AvatarSession();
    const host = new AvatarBrowserHost({
      session,
      assetsPath: assets(),
      token: "test-token",
    });
    hosts.push(host);
    await host.startStandalone(0);
    session.start({ sessionId: "test" });
    const url = new URL(host.rendererUrl);
    const { socket, firstMessage } = await connect(`ws://127.0.0.1:${url.port}/plugins/avatar/stream?token=test-token`);
    expect(await firstMessage).toMatchObject({
      type: "host.hello",
      protocolVersion: 1,
    });
    const stateMessage = nextJson(socket);
    session.state("speaking", 0);
    expect(await stateMessage).toMatchObject({
      type: "state",
      state: "speaking",
    });
    const message = nextJson(socket);
    session.audio(new Uint8Array([0, 128, 255, 127]), 0);
    expect(await message).toMatchObject({
      type: "audio",
      pcmBase64: "AID/fw==",
    });
    socket.send(
      JSON.stringify({
        type: "renderer.status",
        ready: true,
        renderedFrames: 2,
        firstFrame: { nonBackground: true, foregroundPixels: 500 },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.snapshot()).toMatchObject({
      readyClients: 1,
      firstFrameValidated: true,
      sentAudioBytes: 4,
    });
    socket.close();
  });
});
