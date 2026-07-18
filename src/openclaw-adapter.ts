import type { AvatarClearReason, AvatarState } from "./events.js";
import type { AvatarSession } from "./session.js";

type OpenClawOutputMediaEvent =
  | {
      type: "session.start";
      sessionId: string;
      sessionKey?: string;
      generation: number;
      audio: { encoding: "pcm16le"; sampleRateHz: 24_000; channels: 1 };
    }
  | {
      type: "state";
      sessionId: string;
      sessionKey?: string;
      generation: number;
      ptsMs: number;
      state: AvatarState;
    }
  | {
      type: "audio";
      sessionId: string;
      sessionKey?: string;
      generation: number;
      sequence: number;
      ptsMs: number;
      pcm: Uint8Array;
    }
  | {
      type: "clear";
      sessionId: string;
      sessionKey?: string;
      generation: number;
      reason: AvatarClearReason;
    }
  | {
      type: "session.end";
      sessionId: string;
      sessionKey?: string;
      generation: number;
      reason: "completed" | "error" | "replaced";
    };

type OpenClawRuntimeWithOptionalMedia = {
  talk?: {
    subscribeOutputMedia?: (params: {
      sessionId?: string;
      sessionKey?: string;
      onEvent: (event: OpenClawOutputMediaEvent) => void | Promise<void>;
    }) => () => void;
  };
};

export type OpenClawOutputMediaAdapterOptions = {
  runtime: unknown;
  session: AvatarSession;
  video: { width: number; height: number; frameRate: number };
  sessionId?: string;
  sessionKey?: string;
};

/**
 * Feature-detected adapter for OpenClaw's provider-neutral Talk output tap.
 * The adapter maps generations and exact PCM only; it never sees auth/provider
 * configuration and remains absent on hosts that predate the runtime seam.
 */
export function attachOpenClawOutputMedia(
  options: OpenClawOutputMediaAdapterOptions,
): (() => void) | null {
  const runtime = options.runtime as OpenClawRuntimeWithOptionalMedia;
  const subscribe = runtime.talk?.subscribeOutputMedia;
  if (typeof subscribe !== "function") return null;

  let activeSessionId: string | null = null;
  const detach = subscribe({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    onEvent: (event) => {
      if (event.type === "session.start") {
        if (activeSessionId && activeSessionId !== event.sessionId) {
          options.session.end("replaced");
        }
        if (activeSessionId !== event.sessionId) {
          activeSessionId = event.sessionId;
          options.session.start({
            sessionId: event.sessionId,
            generation: event.generation,
            video: options.video,
          });
        }
        return;
      }
      if (event.sessionId !== activeSessionId) return;
      if (event.type === "state") {
        options.session.stateFromSource(event.state, event.ptsMs, event.generation);
      } else if (event.type === "audio") {
        options.session.audioFromSource({
          pcm: event.pcm,
          ptsMs: event.ptsMs,
          generation: event.generation,
          sequence: event.sequence,
        });
      } else if (event.type === "clear") {
        options.session.clearFromSource(event.reason, event.generation);
      } else if (event.type === "session.end") {
        options.session.endFromSource(event.reason, event.generation);
        activeSessionId = null;
      }
    },
  });
  return () => {
    detach();
    if (activeSessionId) options.session.end("adapter-detached");
    activeSessionId = null;
  };
}
