import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAvatarRenderer, type AvatarRenderer } from "../src/renderer.js";

const renderers: AvatarRenderer[] = [];
afterEach(async () => Promise.all(renderers.splice(0).map((renderer) => renderer.stop())));

function assets(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-renderer-"));
  fs.writeFileSync(path.join(directory, "client.js"), "export {};\n");
  fs.writeFileSync(path.join(directory, "styles.css"), "body{}\n");
  return directory;
}

describe("createAvatarRenderer", () => {
  it("starts and stops idempotently around one caller-owned media session", async () => {
    const renderer = createAvatarRenderer({ assetsPath: assets(), token: "factory-token" });
    renderers.push(renderer);
    await renderer.start();
    await renderer.start();
    expect(renderer.rendererUrl).toContain("token=factory-token");
    renderer.consumer.start({
      sessionId: "opaque-call",
      video: { width: 1280, height: 720, frameRate: 30 },
      initialState: "listening",
    });
    expect(renderer.snapshot().session).toMatchObject({
      active: true,
      sessionId: "opaque-call",
      currentState: "listening",
    });
    await renderer.stop();
    await renderer.stop();
    expect(renderer.snapshot()).toMatchObject({ runningStandalone: false });
  });

  it("preserves exact PCM bytes and caller-provided sample-clock timestamps", async () => {
    const renderer = createAvatarRenderer({ assetsPath: assets(), token: "clock-token" });
    renderers.push(renderer);
    await renderer.start();
    renderer.consumer.start({ sessionId: "clock", video: { width: 640, height: 360, frameRate: 30 } });
    const url = new URL(renderer.rendererUrl);
    const socket = new WebSocket(
      `ws://127.0.0.1:${url.port}/avatar/stream?token=clock-token`,
    );
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(messages[0]).toMatchObject({ type: "host.hello" }));
    const pcm = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
    renderer.consumer.audio(pcm, 480 / 24);
    await vi.waitFor(() =>
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "state", state: "speaking", ptsMs: 20 }),
          expect.objectContaining({ type: "audio", ptsMs: 20, pcmBase64: "AID/fw==" }),
        ]),
      ),
    );
    expect(renderer.snapshot().session).toMatchObject({ inputAudioBytes: 4 });
    expect(pcm).toEqual(new Uint8Array([0x00, 0x80, 0xff, 0x7f]));
    socket.close();
  });
});
