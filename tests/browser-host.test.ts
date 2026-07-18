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

function connect(url: string): Promise<{ socket: WebSocket; firstMessage: Promise<Record<string, unknown>> }> {
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
  it("accepts token-authenticated microphone Talk requests on the Gateway-hosted route", async () => {
    const start = vi.fn(async () => ({ sessionId: "talk-1" }));
    const appendAudio = vi.fn(async () => undefined);
    const cancelOutput = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const host = new AvatarBrowserHost({
      session: new AvatarSession(),
      assetsPath: assets(),
      token: "test-token",
      talk: { start, appendAudio, cancelOutput, stop },
    });
    const invoke = async (suffix: string, body: Record<string, unknown>) => {
      let responseBody = "";
      const requestBody = Buffer.from(JSON.stringify(body));
      const request = {
        method: "POST",
        url: `/plugins/avatar-talk/${suffix}?token=test-token`,
        socket: { remoteAddress: "127.0.0.1", localPort: 9999 },
        async *[Symbol.asyncIterator]() {
          yield requestBody;
        },
      };
      const response = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: (value = "") => {
          responseBody = value;
        },
      };
      await host.handleGatewayTalkRequest(request as never, response as never);
      return { status: response.statusCode, body: JSON.parse(responseBody) };
    };

    expect(await invoke("start", {})).toEqual({ status: 200, body: { sessionId: "talk-1" } });
    expect(
      await invoke("audio", { sessionId: "talk-1", audioBase64: "AAE=", timestamp: 25 }),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(await invoke("stop", { sessionId: "talk-1" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(appendAudio).toHaveBeenCalledWith({
      sessionId: "talk-1",
      audioBase64: "AAE=",
      timestamp: 25,
    });
    expect(await invoke("cancel-output", { sessionId: "talk-1" })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(cancelOutput).toHaveBeenCalledWith("talk-1");
    expect(stop).toHaveBeenCalledWith("talk-1");
  });

  it("serves only authenticated loopback requests with a strict CSP", async () => {
    const host = new AvatarBrowserHost({ session: new AvatarSession(), assetsPath: assets(), token: "test-token" });
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
    const host = new AvatarBrowserHost({ session, assetsPath: assets(), token: "test-token" });
    hosts.push(host);
    await host.startStandalone(0);
    session.start({ sessionId: "test" });
    const url = new URL(host.rendererUrl);
    const { socket, firstMessage } = await connect(`ws://127.0.0.1:${url.port}/plugins/avatar/stream?token=test-token`);
    expect(await firstMessage).toMatchObject({ type: "host.hello", protocolVersion: 1 });
    const stateMessage = nextJson(socket);
    session.state("speaking", 0);
    expect(await stateMessage).toMatchObject({ type: "state", state: "speaking" });
    const message = nextJson(socket);
    session.audio(new Uint8Array([0, 128, 255, 127]), 0);
    expect(await message).toMatchObject({ type: "audio", pcmBase64: "AID/fw==" });
    socket.send(JSON.stringify({ type: "renderer.status", ready: true, renderedFrames: 2, firstFrame: { nonBackground: true, foregroundPixels: 500 } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.snapshot()).toMatchObject({ readyClients: 1, firstFrameValidated: true, sentAudioBytes: 4 });
    socket.close();
  });
});
