import { fileURLToPath } from "node:url";
import { createAvatarMediaConsumer, type AvatarMediaConsumer } from "./adapter.js";
import { AvatarBrowserHost } from "./browser-host.js";
import { AvatarSession, type AvatarSessionOptions } from "./session.js";

export type {
  AvatarClearReason,
  AvatarEvent,
  AvatarSessionDescription,
  AvatarState,
  CanonicalViseme,
} from "./events.js";
export type { AvatarMediaConsumer } from "./adapter.js";

export type AvatarRendererOptions = AvatarSessionOptions & {
  port?: number;
  assetsPath?: string;
  routeBase?: string;
  token?: string;
  maxTransportBufferedBytes?: number;
};

export type AvatarRenderer = {
  consumer: AvatarMediaConsumer;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly rendererUrl: string;
  snapshot(): ReturnType<AvatarBrowserHost["snapshot"]>;
};

/**
 * Creates a self-contained loopback renderer. The caller owns media and session
 * lifecycle; this factory never creates or observes a voice/provider session.
 */
export function createAvatarRenderer(options: AvatarRendererOptions = {}): AvatarRenderer {
  const session = new AvatarSession(options);
  const host = new AvatarBrowserHost({
    session,
    assetsPath: options.assetsPath ?? fileURLToPath(new URL("../browser/", import.meta.url)),
    routeBase: options.routeBase ?? "/avatar",
    ...(options.token ? { token: options.token } : {}),
    ...(options.maxTransportBufferedBytes
      ? { maxTransportBufferedBytes: options.maxTransportBufferedBytes }
      : {}),
  });
  const consumer = createAvatarMediaConsumer(session);

  return {
    consumer,
    start: () => host.startStandalone(options.port ?? 0),
    async stop() {
      consumer.end("renderer-stopped");
      await host.stop();
    },
    get rendererUrl() {
      return host.rendererUrl;
    },
    snapshot: () => host.snapshot(),
  };
}
