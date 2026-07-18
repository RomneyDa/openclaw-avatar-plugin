import { describe, expect, it } from "vitest";
import { AVATAR_AUDIO_FORMAT, validateAvatarEvent } from "../src/events.js";

describe("AvatarEvent validation", () => {
  it("accepts the exact canonical PCM format", () => {
    expect(
      validateAvatarEvent({
        type: "session.start",
        sessionId: "voice-1",
        generation: 3,
        audio: AVATAR_AUDIO_FORMAT,
        video: { width: 1280, height: 720, frameRate: 30 },
      }),
    ).toMatchObject({ generation: 3, audio: AVATAR_AUDIO_FORMAT });
    expect(
      validateAvatarEvent({
        type: "audio",
        generation: 3,
        sequence: 9,
        ptsMs: 20,
        pcm: new Uint8Array([0, 128, 255, 127]),
      }),
    ).toMatchObject({ sequence: 9, ptsMs: 20 });
  });

  it.each([
    { name: "NaN timestamp", event: { type: "state", generation: 0, ptsMs: Number.NaN, state: "idle" } },
    { name: "infinite weight", event: { type: "visemes", generation: 0, sequence: 0, ptsMs: 0, weights: { aa: Infinity } } },
    { name: "unknown viseme", event: { type: "visemes", generation: 0, sequence: 0, ptsMs: 0, weights: { wat: 1 } } },
    { name: "odd PCM", event: { type: "audio", generation: 0, sequence: 0, ptsMs: 0, pcm: new Uint8Array(3) } },
    { name: "wrong format", event: { type: "session.start", sessionId: "x", generation: 0, audio: { encoding: "pcm16le", sampleRateHz: 48000, channels: 1 }, video: { width: 1280, height: 720, frameRate: 30 } } },
  ])("rejects $name", ({ event }) => {
    expect(() => validateAvatarEvent(event)).toThrow();
  });

  it("rejects oversized chunks before allocation or fanout", () => {
    expect(() =>
      validateAvatarEvent(
        { type: "audio", generation: 0, sequence: 0, ptsMs: 0, pcm: new Uint8Array(10) },
        { maxAudioChunkBytes: 8 },
      ),
    ).toThrow(/complete PCM16LE samples/);
  });
});
