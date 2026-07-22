import { describe, expect, it, vi } from "vitest";
import type { AvatarEvent } from "../src/events.js";
import { attachOpenClawActivity } from "../src/openclaw-adapter.js";
import { AvatarSession } from "../src/session.js";

describe("OpenClaw activity adapter", () => {
  it("feature-detects stock hosts without disabling the renderer", () => {
    expect(
      attachOpenClawActivity({
        runtime: {},
        session: new AvatarSession(),
        video: { width: 1280, height: 720, frameRate: 30 },
      }),
    ).toBeNull();
  });

  it("maps anonymous Talk activity to state and viseme motion", async () => {
    let onEvent!: (event: any) => void;
    const detach = vi.fn();
    const runtime = {
      talk: {
        watchActivity: (listener: typeof onEvent) => {
          onEvent = listener;
          return detach;
        },
      },
    };
    const session = new AvatarSession();
    const received: AvatarEvent[] = [];
    session.subscribe("test", (event) => {
      received.push(event);
    });
    const stop = attachOpenClawActivity({
      runtime,
      session,
      video: { width: 960, height: 540, frameRate: 30 },
    });

    onEvent({
      type: "started",
      activityId: "opaque",
      timestamp: "2026-07-22T00:00:00Z",
    });
    onEvent({
      type: "state",
      activityId: "opaque",
      timestamp: "2026-07-22T00:00:00Z",
      state: "thinking",
    });
    onEvent({
      type: "speech",
      activityId: "opaque",
      timestamp: "2026-07-22T00:00:00.020Z",
    });
    await vi.waitFor(() => expect(received.some((event) => event.type === "visemes")).toBe(true));
    onEvent({
      type: "ended",
      activityId: "opaque",
      timestamp: "2026-07-22T00:00:00.040Z",
    });

    expect(received[0]).toMatchObject({
      type: "session.start",
      sessionId: "activity:opaque",
      video: { width: 960, height: 540 },
    });
    expect(received.some((event) => event.type === "state" && event.state === "speaking")).toBe(true);
    await vi.waitFor(() => expect(received.some((event) => event.type === "session.end")).toBe(true));
    expect(received.at(-1)?.type).toBe("session.end");
    const eventCount = received.length;
    onEvent({
      type: "ended",
      activityId: "suppressed-interactive-session",
      timestamp: "2026-07-22T00:00:00.060Z",
    });
    expect(received).toHaveLength(eventCount);
    stop?.();
    expect(detach).toHaveBeenCalledOnce();
  });
});
