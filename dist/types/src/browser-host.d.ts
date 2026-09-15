import { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import type { AvatarSession } from "./session.js";
export type AvatarBrowserHostOptions = {
    session: AvatarSession;
    assetsPath: string;
    routeBase?: string;
    token?: string;
    maxTransportBufferedBytes?: number;
};
export declare function isLoopbackAddress(address: string | undefined): boolean;
export declare class AvatarBrowserHost {
    #private;
    readonly session: AvatarSession;
    readonly assetsPath: string;
    readonly routeBase: string;
    readonly token: string;
    readonly maxTransportBufferedBytes: number;
    readonly webSockets: import("ws").Server<typeof WebSocket, typeof IncomingMessage>;
    constructor(options: AvatarBrowserHostOptions);
    get rendererPath(): string;
    get rendererUrl(): string;
    startStandalone(port?: number): Promise<void>;
    handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
    snapshot(): {
        runningStandalone: boolean;
        port: number | null;
        connectedClients: number;
        readyClients: number;
        sentEvents: number;
        sentAudioBytes: number;
        droppedTransportMedia: number;
        renderedFrames: number;
        firstFrameValidated: boolean;
        rendererError: string | null;
        session: import("./session.js").AvatarSessionMetrics & {
            active: boolean;
            sessionId: string | null;
        };
    };
    stop(): Promise<void>;
    private onConnection;
    private assertAssets;
    private matches;
    private suffix;
    private validToken;
    private applySecurityHeaders;
    private indexHtml;
}
