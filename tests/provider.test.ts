import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../plugin.js";
import {
  createLobsterLiveVisualProvider,
  type LiveVisualProvider,
  type LiveVisualSession,
} from "../src/provider.js";

const sessions: LiveVisualSession[] = [];
afterEach(async () => Promise.all(sessions.splice(0).map((session) => session.close())));

function assets(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-provider-"));
  fs.writeFileSync(path.join(directory, "client.js"), "export {};\n");
  fs.writeFileSync(path.join(directory, "styles.css"), "body{}\n");
  return directory;
}

describe("lobster live visual provider", () => {
  it("registers through the generic OpenClaw provider seam", () => {
    let registered: LiveVisualProvider | undefined;
    plugin.register({
      registerLiveVisualProvider(provider) {
        registered = provider;
      },
    });
    expect(registered).toMatchObject({ id: "lobster", label: "OpenClaw Lobster" });
  });

  it("publishes timed PCM and cues to its authenticated browser surface", async () => {
    const provider = createLobsterLiveVisualProvider({
      assetsPath: assets(),
      token: "provider-token",
    });
    const session = await provider.open({
      streamId: "generic-stream",
      clock: { unitsPerSecond: 24_000 },
      video: { width: 1_280, height: 720, frameRate: 30 },
      audio: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
    });
    sessions.push(session);
    expect(session.output).toMatchObject({ kind: "browser-source" });
    expect(session.output.url).toContain("token=provider-token");

    const url = new URL(session.output.url);
    const socket = new WebSocket(
      `ws://127.0.0.1:${url.port}/avatar/stream?token=provider-token`,
    );
    const messages: Record<string, unknown>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    session.write({ type: "cue", pts: 240, name: "activity", value: "thinking" });
    const pcm = new Uint8Array([0, 128, 255, 127]);
    session.write({ type: "audio", pts: 480, data: pcm });
    await vi.waitFor(() =>
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "state", state: "thinking", ptsMs: 10 }),
          expect.objectContaining({ type: "audio", ptsMs: 20, pcmBase64: "AID/fw==" }),
        ]),
      ),
    );
    session.write({ type: "flush", reason: "interrupted" });

    await vi.waitFor(() =>
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "clear", reason: "interrupted" }),
        ]),
      ),
    );
    expect(pcm).toEqual(new Uint8Array([0, 128, 255, 127]));
    socket.close();
  });

  it("rejects unsupported input tracks before starting a renderer", async () => {
    const provider = createLobsterLiveVisualProvider({ assetsPath: assets() });
    await expect(
      provider.open({
        streamId: "wrong-format",
        clock: { unitsPerSecond: 48_000 },
        video: { width: 640, height: 360, frameRate: 30 },
        audio: { encoding: "pcm-s16le", sampleRateHz: 48_000, channels: 2 },
      }),
    ).rejects.toThrow(/24000 Hz/);
  });
});
