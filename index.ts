import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { AvatarBrowserHost } from "./src/browser-host.js";
import { attachOpenClawActivity } from "./src/openclaw-adapter.js";
import { AvatarSession } from "./src/session.js";

type AvatarPluginConfig = {
  enabled?: boolean;
  sessionKey?: string;
  standalonePort?: number;
  maxAudioChunkBytes?: number;
  maxSubscriberMediaBytes?: number;
  video?: { width?: number; height?: number; frameRate?: number };
};

type AvatarProcessState = {
  session: AvatarSession;
  host: AvatarBrowserHost;
  detachMedia: (() => void) | null;
  serviceStarts: number;
  hasInteractiveSession: () => boolean;
};

type AvatarProcessGlobal = typeof globalThis & {
  openclawAvatarPluginState?: AvatarProcessState;
};

type InteractiveTalkEvent =
  | {
      type: "state";
      generation: number;
      ptsMs: number;
      state: "idle" | "listening" | "thinking" | "speaking" | "error";
    }
  | {
      type: "audio";
      generation: number;
      sequence: number;
      ptsMs: number;
      pcm: Uint8Array;
    }
  | {
      type: "clear";
      generation: number;
      reason: "barge-in" | "cancel" | "replace" | "hangup" | "error";
    }
  | {
      type: "closed";
      generation: number;
      reason: "completed" | "error" | "replaced";
    };

type InteractiveTalkSession = {
  sendAudio: (pcm: Uint8Array, options?: { timestamp?: number }) => void;
  cancelOutput: (reason?: string) => void;
  close: () => void;
};

type AvatarTalkRuntime = {
  openSession: (params: {
    sessionKey: string;
    onEvent: (event: InteractiveTalkEvent) => void | Promise<void>;
  }) => Promise<InteractiveTalkSession>;
};

function processAvatarState(
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  config: AvatarPluginConfig,
  video: { width: number; height: number; frameRate: number },
): AvatarProcessState {
  const shared = globalThis as AvatarProcessGlobal;
  if (!shared.openclawAvatarPluginState) {
    const session = new AvatarSession({
      maxAudioChunkBytes: config.maxAudioChunkBytes ?? 96_000,
      maxSubscriberMediaBytes: config.maxSubscriberMediaBytes ?? 1_048_576,
      onSubscriberError: (id, error) => {
        api.logger.warn(`avatar subscriber ${id} detached: ${error.message}`);
      },
    });
    const talkSessions = new Map<string, InteractiveTalkSession>();
    let openingSessions = 0;
    const startAvatarSession = (sessionId: string, generation: number) => {
      if (session.snapshot().active) session.end("source-replaced");
      session.start({ sessionId, generation, video });
    };
    const talkRuntime = (api.runtime as unknown as { talk?: AvatarTalkRuntime }).talk;
    shared.openclawAvatarPluginState = {
      session,
      host: new AvatarBrowserHost({
        session,
        assetsPath: fileURLToPath(new URL("./browser/", import.meta.url)),
        token: randomBytes(24).toString("base64url"),
        talk: {
          start: async () => {
            if (!talkRuntime?.openSession) {
              throw new Error("This OpenClaw version does not support interactive plugin Talk sessions");
            }
            const sessionKey = config.sessionKey?.trim() || "agent:main:main";
            const id = randomUUID();
            let started = false;
            let closed = false;
            openingSessions += 1;
            try {
              const talkSession = await talkRuntime.openSession({
                sessionKey,
                onEvent: (event) => {
                  if (!started) {
                    startAvatarSession(id, event.generation);
                    started = true;
                  }
                  if (event.type === "state") {
                    session.stateFromSource(event.state, event.ptsMs, event.generation);
                  } else if (event.type === "audio") {
                    session.audioFromSource(event);
                  } else if (event.type === "clear") {
                    session.clearFromSource(event.reason, event.generation);
                  } else if (event.type === "closed") {
                    closed = true;
                    session.endFromSource(event.reason, event.generation);
                    talkSessions.delete(id);
                  }
                },
              });
              if (closed) {
                talkSession.close();
                throw new Error("Talk session closed while it was opening");
              }
              talkSessions.set(id, talkSession);
              return { sessionId: id };
            } finally {
              openingSessions -= 1;
            }
          },
          appendAudio: async ({ sessionId, audioBase64, timestamp }) => {
            const talkSession = talkSessions.get(sessionId);
            if (!talkSession) throw new Error("Unknown avatar Talk session");
            talkSession.sendAudio(Buffer.from(audioBase64, "base64"), {
              timestamp,
            });
          },
          cancelOutput: async (sessionId) => {
            talkSessions.get(sessionId)?.cancelOutput("barge-in");
          },
          stop: async (sessionId) => {
            const talkSession = talkSessions.get(sessionId);
            talkSessions.delete(sessionId);
            talkSession?.close();
          },
        },
      }),
      detachMedia: null,
      serviceStarts: 0,
      hasInteractiveSession: () => openingSessions > 0 || talkSessions.size > 0,
    };
  }
  return shared.openclawAvatarPluginState;
}

export { createAvatarMediaConsumer, type AvatarMediaConsumer, type AvatarMediaSourceAdapter } from "./src/adapter.js";
export { AvatarBrowserHost, isLoopbackAddress } from "./src/browser-host.js";
export {
  AVATAR_AUDIO_FORMAT,
  CANONICAL_VISEMES,
  type AvatarClearReason,
  type AvatarEvent,
  type AvatarSessionDescription,
  type AvatarState,
  type CanonicalViseme,
  validateAvatarEvent,
} from "./src/events.js";
export { attachOpenClawActivity } from "./src/openclaw-adapter.js";
export { AvatarSession, type AvatarSessionMetrics, type AvatarSessionOptions } from "./src/session.js";

const avatarPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "avatar",
  name: "OpenClaw Avatar",
  description: "Local animated avatar surface driven by canonical voice-session media events.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as AvatarPluginConfig;
    if (config.enabled === false) return;
    const video = {
      width: config.video?.width ?? 1280,
      height: config.video?.height ?? 720,
      frameRate: config.video?.frameRate ?? 30,
    };
    const state = processAvatarState(api, config, video);
    const { host, session } = state;

    api.registerHttpRoute({
      path: "/plugins/avatar",
      auth: "gateway",
      match: "prefix",
      handler: (request, response) => host.handleRequest(request, response),
      handleUpgrade: (request, socket, head) => host.handleUpgrade(request, socket, head),
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "avatar",
      label: "Avatar",
      description: "Live local voice avatar and renderer health.",
      icon: "sparkles",
      group: "agent",
      order: 20,
      requiredScopes: ["operator.read", "operator.write", "operator.talk.secrets"],
      path: host.rendererPath,
    });
    api.registerService({
      id: "avatar",
      start: async () => {
        state.serviceStarts += 1;
        if (state.serviceStarts > 1) return;
        state.detachMedia = attachOpenClawActivity({
          runtime: api.runtime,
          session,
          video,
          isSuppressed: state.hasInteractiveSession,
        });
        if (!state.detachMedia) {
          session.start({ sessionId: "local-idle", video });
          session.state("listening", 0);
          api.logger.info("avatar media tap unavailable; local idle/standalone renderer remains ready");
        }
        if ((config.standalonePort ?? 0) > 0) {
          await host.startStandalone(config.standalonePort);
          api.logger.info(`avatar standalone host listening on loopback port ${config.standalonePort}`);
        }
      },
      stop: async () => {
        state.serviceStarts = Math.max(0, state.serviceStarts - 1);
        if (state.serviceStarts > 0) return;
        state.detachMedia?.();
        state.detachMedia = null;
        session.end("plugin-stopped");
        await host.stop();
      },
    });
  },
});

export default avatarPlugin;
