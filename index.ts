import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { AvatarBrowserHost } from "./src/browser-host.js";
import { attachOpenClawOutputMedia } from "./src/openclaw-adapter.js";
import { AvatarSession } from "./src/session.js";

type AvatarPluginConfig = {
  enabled?: boolean;
  standalonePort?: number;
  maxAudioChunkBytes?: number;
  maxSubscriberMediaBytes?: number;
  video?: { width?: number; height?: number; frameRate?: number };
};

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
    const session = new AvatarSession({
      maxAudioChunkBytes: config.maxAudioChunkBytes ?? 96_000,
      maxSubscriberMediaBytes: config.maxSubscriberMediaBytes ?? 1_048_576,
      onSubscriberError: (id, error) => {
        api.logger.warn(`avatar subscriber ${id} detached: ${error.message}`);
      },
    });
    const host = new AvatarBrowserHost({
      session,
      assetsPath: fileURLToPath(new URL("./browser/", import.meta.url)),
    });
    let detachMedia: (() => void) | null = null;

    api.registerHttpRoute({
      path: "/plugins/avatar",
      auth: "plugin",
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
      requiredScopes: ["operator.read"],
      path: host.rendererPath,
    });
    api.registerService({
      id: "avatar",
      start: async () => {
        detachMedia = attachOpenClawOutputMedia({ runtime: api.runtime, session, video });
        if (!detachMedia) {
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
        detachMedia?.();
        detachMedia = null;
        session.end("plugin-stopped");
        await host.stop();
      },
    });
  },
});

export default avatarPlugin;
