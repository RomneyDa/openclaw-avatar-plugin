import { describe, expect, it, vi } from "vitest";
import type { AvatarEvent } from "../src/events.js";
import { attachOpenClawOutputMedia } from "../src/openclaw-adapter.js";
import { AvatarSession } from "../src/session.js";

describe("OpenClaw output-media adapter", () => {
  it("feature-detects stock hosts without disabling the renderer", () => {
    expect(
      attachOpenClawOutputMedia({
        runtime: {},
        session: new AvatarSession(),
        video: { width: 1280, height: 720, frameRate: 30 },
      }),
    ).toBeNull();
  });

  it("maps provider-neutral core events without changing PCM or generations", async () => {
    let onEvent!: (event: any) => void;
    const detach = vi.fn();
    const runtime = {
      talk: {
        subscribeOutputMedia: (params: { onEvent: typeof onEvent }) => {
          onEvent = params.onEvent;
          return detach;
        },
      },
    };
    const session = new AvatarSession();
    const received: AvatarEvent[] = [];
    session.subscribe("test", (event) => {
      received.push(event);
    });
    const stop = attachOpenClawOutputMedia({
      runtime,
      session,
      video: { width: 960, height: 540, frameRate: 30 },
    });
    const pcm = new Uint8Array([0, 128, 255, 127]);
    onEvent({ type: "session.start", sessionId: "voice", generation: 4, audio: { encoding: "pcm16le", sampleRateHz: 24000, channels: 1 } });
    onEvent({ type: "state", sessionId: "voice", generation: 4, ptsMs: 0, state: "thinking" });
    onEvent({ type: "audio", sessionId: "voice", generation: 4, sequence: 9, ptsMs: 20, pcm });
    await vi.waitFor(() => expect(received.some((event) => event.type === "audio")).toBe(true));
    onEvent({ type: "clear", sessionId: "voice", generation: 5, reason: "barge-in" });
    onEvent({ type: "session.end", sessionId: "voice", generation: 5, reason: "completed" });
    await vi.waitFor(() => expect(received.some((event) => event.type === "session.end")).toBe(true));
    expect(received[0]).toMatchObject({ type: "session.start", generation: 4, video: { width: 960, height: 540 } });
    const audio = received.find((event): event is Extract<AvatarEvent, { type: "audio" }> => event.type === "audio");
    expect(audio).toMatchObject({ generation: 4, sequence: 9, ptsMs: 20 });
    expect(audio?.pcm).toBe(pcm);
    expect(received.find((event) => event.type === "clear")).toMatchObject({ generation: 5, reason: "barge-in" });
    stop?.();
    expect(detach).toHaveBeenCalledOnce();
  });
});
