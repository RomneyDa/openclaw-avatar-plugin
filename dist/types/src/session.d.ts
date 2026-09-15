import { type AvatarClearReason, type AvatarEvent, type AvatarState, type CanonicalViseme } from "./events.js";
export type AvatarSubscriber = (event: AvatarEvent) => void | Promise<void>;
export type AvatarSessionOptions = {
    maxAudioChunkBytes?: number;
    maxSubscriberMediaBytes?: number;
    maxSubscriberMediaEvents?: number;
    maxSubscriberControlEvents?: number;
    onSubscriberError?: (subscriberId: string, error: Error) => void;
};
export type AvatarSessionMetrics = {
    generation: number;
    currentState: AvatarState;
    subscribers: number;
    inputAudioBytes: number;
    visemeFrames: number;
    controlEvents: number;
    deliveredEvents: number;
    droppedMediaEvents: number;
    droppedMediaBytes: number;
    subscriberFailures: number;
    queueDepth: number;
    queuedMediaBytes: number;
};
type QueueEntry = {
    event: AvatarEvent;
    mediaBytes: number;
};
declare class SubscriberQueue {
    readonly id: string;
    readonly handler: AvatarSubscriber;
    readonly options: Required<Pick<AvatarSessionOptions, "maxSubscriberMediaBytes" | "maxSubscriberMediaEvents" | "maxSubscriberControlEvents">>;
    readonly metrics: AvatarSessionMetrics;
    readonly onError?: AvatarSessionOptions["onSubscriberError"];
    queue: QueueEntry[];
    queuedMediaBytes: number;
    active: boolean;
    draining: boolean;
    constructor(params: {
        id: string;
        handler: AvatarSubscriber;
        options: SubscriberQueue["options"];
        metrics: AvatarSessionMetrics;
        onError?: AvatarSessionOptions["onSubscriberError"];
    });
    enqueue(event: AvatarEvent): boolean;
    stop(): void;
    private drain;
    private fail;
    private updateDepthMetrics;
}
export declare class AvatarSession {
    #private;
    readonly options: Required<Pick<AvatarSessionOptions, "maxAudioChunkBytes" | "maxSubscriberMediaBytes" | "maxSubscriberMediaEvents" | "maxSubscriberControlEvents">> & Pick<AvatarSessionOptions, "onSubscriberError">;
    readonly subscribers: Map<string, SubscriberQueue>;
    readonly metrics: AvatarSessionMetrics;
    constructor(options?: AvatarSessionOptions);
    subscribe(id: string, handler: AvatarSubscriber): () => void;
    start(params: {
        sessionId: string;
        generation?: number;
        video?: {
            width: number;
            height: number;
            frameRate: number;
        };
    }): void;
    audio(pcm: Uint8Array, ptsMs: number): boolean;
    audioFromSource(params: {
        pcm: Uint8Array;
        ptsMs: number;
        generation: number;
        sequence: number;
    }): boolean;
    visemes(weights: Partial<Record<CanonicalViseme, number>>, ptsMs: number): boolean;
    state(state: AvatarState, ptsMs: number): void;
    stateFromSource(state: AvatarState, ptsMs: number, generation: number): boolean;
    expression(name: string, intensity: number, transitionMs: number, ptsMs: number): void;
    clear(reason: AvatarClearReason): number;
    clearFromSource(reason: AvatarClearReason, generation: number): boolean;
    end(reason: string): void;
    endFromSource(reason: string, generation: number): boolean;
    snapshot(): AvatarSessionMetrics & {
        active: boolean;
        sessionId: string | null;
    };
    private publish;
    private recalculateQueueMetrics;
    private requireActive;
}
export {};
