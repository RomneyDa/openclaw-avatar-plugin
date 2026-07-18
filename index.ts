import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { AvatarBrowserHost } from "./src/browser-host.js";
import { attachOpenClawOutputMedia } from "./src/openclaw-adapter.js";
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
};

type AvatarProcessGlobal = typeof globalThis & { openclawAvatarPluginState?: AvatarProcessState };

async function requestTalkGateway<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await dispatchGatewayMethod(method, params, { timeoutMs: 30_000 });
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`);
  }
  return response.payload as T;
}

function processAvatarState(
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  config: AvatarPluginConfig,
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
    shared.openclawAvatarPluginState = {
      session,
      host: new AvatarBrowserHost({
        session,
        assetsPath: fileURLToPath(new URL("./browser/", import.meta.url)),
        token: randomBytes(24).toString("base64url"),
        talk: {
          start: async () => {
            const sessionKey = config.sessionKey?.trim() || "agent:main:main";
            const result = await requestTalkGateway<{ sessionId?: unknown }>(
              "talk.session.create",
              {
                mode: "realtime",
                transport: "gateway-relay",
                brain: "agent-consult",
                sessionKey,
                agentConsultOwner: "gateway",
              },
            );
            if (typeof result.sessionId !== "string" || !result.sessionId) {
              throw new Error("OpenClaw did not return a Talk session id");
            }
            return { sessionId: result.sessionId };
          },
          appendAudio: async (params) => {
            await requestTalkGateway("talk.session.appendAudio", params);
          },
          cancelOutput: async (sessionId) => {
            await requestTalkGateway("talk.session.cancelOutput", {
              sessionId,
              reason: "barge-in",
            });
          },
          stop: async (sessionId) => {
            await requestTalkGateway("talk.session.close", { sessionId });
          },
        },
      }),
      detachMedia: null,
      serviceStarts: 0,
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
export { attachOpenClawOutputMedia } from "./src/openclaw-adapter.js";
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
    const state = processAvatarState(api, config);
    const { host, session } = state;

    api.registerHttpRoute({
      path: "/plugins/avatar",
      auth: "plugin",
      match: "prefix",
      handler: (request, response) => host.handleRequest(request, response),
      handleUpgrade: (request, socket, head) => host.handleUpgrade(request, socket, head),
    });
    api.registerHttpRoute({
      path: "/plugins/avatar-talk",
      auth: "gateway",
      match: "prefix",
      handler: (request, response) => host.handleGatewayTalkRequest(request, response),
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
        state.detachMedia = attachOpenClawOutputMedia({ runtime: api.runtime, session, video });
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
