import { describe, expect, it, vi } from "vitest";
import type { AvatarEvent } from "../src/events.js";
import { AvatarSession } from "../src/session.js";

describe("AvatarSession", () => {
  it("invalidates queued old-generation media before clear", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const received: AvatarEvent[] = [];
    const session = new AvatarSession();
    session.subscribe("slow", async (event) => {
      received.push(event);
      if (event.type === "session.start") await blocked;
    });
    session.start({ sessionId: "s" });
    session.audio(new Uint8Array([0, 0]), 0);
    session.audio(new Uint8Array([1, 0]), 20);
    const generation = session.clear("barge-in");
    release();
    await vi.waitFor(() => expect(received.some((event) => event.type === "clear")).toBe(true));
    expect(generation).toBe(1);
    expect(received.filter((event) => event.type === "audio")).toHaveLength(0);
    expect(session.snapshot().droppedMediaEvents).toBeGreaterThanOrEqual(2);
  });

  it("isolates a slow subscriber from a healthy sibling and bounds media", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const fast: string[] = [];
    const session = new AvatarSession({ maxSubscriberMediaBytes: 4, maxSubscriberMediaEvents: 2 });
    session.subscribe("slow", async (event) => {
      if (event.type === "session.start") await blocked;
    });
    session.subscribe("fast", (event) => {
      fast.push(event.type);
    });
    session.start({ sessionId: "s" });
    for (let index = 0; index < 6; index += 1) session.audio(new Uint8Array([index, 0]), index * 20);
    await vi.waitFor(() => expect(fast.filter((type) => type === "audio").length).toBeGreaterThan(0));
    expect(session.snapshot().queuedMediaBytes).toBeLessThanOrEqual(4);
    expect(session.snapshot().droppedMediaEvents).toBeGreaterThan(0);
    release();
  });

  it("detaches a failing subscriber without throwing into media ownership", async () => {
    const errors: string[] = [];
    const session = new AvatarSession({ onSubscriberError: (id) => errors.push(id) });
    session.subscribe("broken", () => {
      throw new Error("renderer failed");
    });
    session.start({ sessionId: "s" });
    expect(() => session.audio(new Uint8Array([0, 0]), 0)).not.toThrow();
    await vi.waitFor(() => expect(errors).toEqual(["broken"]));
    expect(session.snapshot()).toMatchObject({ subscribers: 0, subscriberFailures: 1 });
  });

  it("preserves source generation and sequence exactly", async () => {
    const received: AvatarEvent[] = [];
    const session = new AvatarSession();
    session.subscribe("renderer", (event) => {
      received.push(event);
    });
    session.start({ sessionId: "core", generation: 7 });
    session.audioFromSource({ pcm: new Uint8Array([1, 0]), ptsMs: 40, generation: 7, sequence: 12 });
    await vi.waitFor(() => expect(received.some((event) => event.type === "audio")).toBe(true));
    expect(session.clearFromSource("cancel", 8)).toBe(true);
    expect(session.audioFromSource({ pcm: new Uint8Array([2, 0]), ptsMs: 0, generation: 7, sequence: 13 })).toBe(false);
    await vi.waitFor(() => expect(received.some((event) => event.type === "clear")).toBe(true));
    expect(received.find((event) => event.type === "audio")).toMatchObject({ generation: 7, sequence: 12 });
    expect(session.snapshot().generation).toBe(8);
  });

  it("owns an exact PCM copy before asynchronous renderer delivery", async () => {
    const received: AvatarEvent[] = [];
    const session = new AvatarSession();
    session.subscribe("renderer", (event) => {
      received.push(event);
    });
    session.start({ sessionId: "pcm" });
    const pcm = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
    session.audio(pcm, 0);
    pcm.fill(0);
    await vi.waitFor(() => expect(received.some((event) => event.type === "audio")).toBe(true));
    expect(received.find((event) => event.type === "audio")).toMatchObject({
      pcm: new Uint8Array([0x00, 0x80, 0xff, 0x7f]),
    });
  });
});
