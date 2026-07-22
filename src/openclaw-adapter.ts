import type { AvatarSession } from "./session.js";

type OpenClawActivityEvent =
  | { type: "started"; activityId: string; timestamp: string }
  | {
      type: "state";
      activityId: string;
      timestamp: string;
      state: "idle" | "listening" | "thinking" | "speaking" | "error";
    }
  | { type: "speech"; activityId: string; timestamp: string }
  | { type: "ended"; activityId: string; timestamp: string };

type OpenClawRuntimeWithActivity = {
  talk?: {
    watchActivity?: (listener: (event: OpenClawActivityEvent) => void | Promise<void>) => () => void;
  };
};

export type OpenClawActivityAdapterOptions = {
  runtime: unknown;
  session: AvatarSession;
  video: { width: number; height: number; frameRate: number };
  isSuppressed?: () => boolean;
};

export function attachOpenClawActivity(options: OpenClawActivityAdapterOptions): (() => void) | null {
  const watch = (options.runtime as OpenClawRuntimeWithActivity).talk?.watchActivity;
  if (typeof watch !== "function") return null;

  let activeId: string | null = null;
  let startedAt = 0;
  let pulse = 0;
  const ensureSession = (event: OpenClawActivityEvent) => {
    if (activeId === event.activityId && options.session.snapshot().active) return;
    if (options.session.snapshot().active) options.session.end("activity-replaced");
    activeId = event.activityId;
    startedAt = Date.parse(event.timestamp) || Date.now();
    pulse = 0;
    options.session.start({
      sessionId: `activity:${event.activityId}`,
      video: options.video,
    });
  };

  const stop = watch((event) => {
    if (options.isSuppressed?.()) return;
    if (event.type === "ended" && activeId !== event.activityId) return;
    ensureSession(event);
    const ptsMs = Math.max(0, (Date.parse(event.timestamp) || Date.now()) - startedAt);
    if (event.type === "state") {
      options.session.state(event.state, ptsMs);
    } else if (event.type === "speech") {
      pulse += 1;
      options.session.state("speaking", ptsMs);
      options.session.visemes(pulse % 2 === 0 ? { aa: 0.9, E: 0.15 } : { aa: 0.35, O: 0.55 }, ptsMs);
    } else if (event.type === "ended" && activeId === event.activityId) {
      options.session.end("activity-ended");
      activeId = null;
    }
  });

  return () => {
    stop();
    if (activeId && options.session.snapshot().active) options.session.end("adapter-detached");
    activeId = null;
  };
}
