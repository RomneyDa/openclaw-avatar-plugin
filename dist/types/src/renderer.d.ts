import { type AvatarMediaConsumer } from "./adapter.js";
import { AvatarBrowserHost } from "./browser-host.js";
import { type AvatarSessionOptions } from "./session.js";
export type { AvatarClearReason, AvatarEvent, AvatarSessionDescription, AvatarState, CanonicalViseme, } from "./events.js";
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
export declare function createAvatarRenderer(options?: AvatarRendererOptions): AvatarRenderer;
