import { createAvatarRenderer, type AvatarRendererOptions } from "./renderer.js";
import type { AvatarState } from "./events.js";

export type LiveVisualAudioFormat = Readonly<{
  encoding: "pcm-s16le";
  sampleRateHz: number;
  channels: number;
}>;

export type LiveVisualSessionOpenRequest = Readonly<{
  streamId: string;
  clock: Readonly<{ unitsPerSecond: number }>;
  video: Readonly<{ width: number; height: number; frameRate: number }>;
  audio?: LiveVisualAudioFormat;
}>;

export type LiveVisualInputEvent =
  | Readonly<{ type: "audio"; pts: number; data: Uint8Array }>
  | Readonly<{ type: "cue"; pts: number; name: string; value: string | number | boolean }>
  | Readonly<{ type: "flush"; reason?: string }>;

export type LiveVisualHealth = Readonly<{
  status: "starting" | "ready" | "degraded" | "closed";
  droppedMediaBytes: number;
  error?: string;
}>;

export type LiveVisualSession = {
  readonly output: Readonly<{
    kind: "browser-source";
    url: string;
    video: LiveVisualSessionOpenRequest["video"];
  }>;
  write(event: LiveVisualInputEvent): boolean;
  health(): LiveVisualHealth;
  close(reason?: string): Promise<void>;
};

export type LiveVisualProvider = {
  id: string;
  label: string;
  open(request: LiveVisualSessionOpenRequest): Promise<LiveVisualSession>;
};

const AVATAR_STATES = new Set<AvatarState>([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "error",
]);

function requireSupportedAudio(format: LiveVisualAudioFormat | undefined): void {
  if (
    !format ||
    format.encoding !== "pcm-s16le" ||
    format.sampleRateHz !== 24_000 ||
    format.channels !== 1
  ) {
    throw new Error("lobster live visual requires mono PCM S16LE audio at 24000 Hz");
  }
}

export function createLobsterLiveVisualProvider(
  options: AvatarRendererOptions = {},
): LiveVisualProvider {
  return {
    id: "lobster",
    label: "OpenClaw Lobster",
    async open(request) {
      requireSupportedAudio(request.audio);
      if (!Number.isSafeInteger(request.clock.unitsPerSecond) || request.clock.unitsPerSecond <= 0) {
        throw new Error("live visual clock unitsPerSecond must be a positive safe integer");
      }
      const renderer = createAvatarRenderer(options);
      await renderer.start();
      renderer.consumer.start({
        sessionId: request.streamId,
        video: request.video,
        initialState: "idle",
      });
      let closed = false;
      const toMs = (pts: number) => (pts * 1_000) / request.clock.unitsPerSecond;
      return {
        output: { kind: "browser-source", url: renderer.rendererUrl, video: request.video },
        write(event) {
          if (closed) return false;
          if (event.type === "audio") {
            return renderer.consumer.audio(event.data, toMs(event.pts));
          }
          if (event.type === "flush") {
            renderer.consumer.clear(event.reason?.trim() || "flush");
            return true;
          }
          if (
            event.name === "activity" &&
            typeof event.value === "string" &&
            AVATAR_STATES.has(event.value as AvatarState)
          ) {
            renderer.consumer.state(event.value as AvatarState, toMs(event.pts));
          }
          return true;
        },
        health() {
          const snapshot = renderer.snapshot();
          const error = snapshot.rendererError ?? undefined;
          return {
            status: closed
              ? "closed"
              : error
                ? "degraded"
                : snapshot.readyClients > 0
                  ? "ready"
                  : "starting",
            droppedMediaBytes:
              snapshot.session.droppedMediaBytes + snapshot.droppedTransportMedia,
            ...(error ? { error } : {}),
          } satisfies LiveVisualHealth;
        },
        async close(reason = "closed") {
          if (closed) return;
          closed = true;
          renderer.consumer.end(reason);
          await renderer.stop();
        },
      } satisfies LiveVisualSession;
    },
  };
}
