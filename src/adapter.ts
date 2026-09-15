import type {
  AvatarClearReason,
  AvatarSessionDescription,
  AvatarState,
  CanonicalViseme,
} from "./events.js";
import type { AvatarSession } from "./session.js";

/**
 * Narrow media-owner boundary expected from OpenClaw core. An adapter observes
 * the already-active playback session; it never creates a provider session and
 * never receives provider credentials.
 */
export type AvatarMediaConsumer = {
  start(
    description: Omit<AvatarSessionDescription, "generation" | "audio"> & {
      initialState?: AvatarState;
    },
  ): void;
  audio(pcm16le24kMono: Uint8Array, ptsMs: number): boolean;
  visemes(weights: Partial<Record<CanonicalViseme, number>>, ptsMs: number): boolean;
  state(state: AvatarState, ptsMs: number): void;
  expression(name: string, intensity: number, transitionMs: number, ptsMs: number): void;
  clear(reason: AvatarClearReason): number;
  end(reason: string): void;
};

export interface AvatarMediaSourceAdapter {
  /** Attach once to the media owner and return an idempotent detach function. */
  attach(consumer: AvatarMediaConsumer): void | (() => void) | Promise<void | (() => void)>;
}

export function createAvatarMediaConsumer(session: AvatarSession): AvatarMediaConsumer {
  return {
    start: ({ sessionId, video, initialState }) => {
      session.start({ sessionId, video });
      if (initialState && initialState !== "idle") session.state(initialState, 0);
    },
    audio: (pcm, ptsMs) => session.audio(pcm, ptsMs),
    visemes: (weights, ptsMs) => session.visemes(weights, ptsMs),
    state: (state, ptsMs) => session.state(state, ptsMs),
    expression: (name, intensity, transitionMs, ptsMs) =>
      session.expression(name, intensity, transitionMs, ptsMs),
    clear: (reason) => session.clear(reason),
    end: (reason) => session.end(reason),
  };
}
