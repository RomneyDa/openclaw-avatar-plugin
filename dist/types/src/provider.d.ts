import { type AvatarRendererOptions } from "./renderer.js";
export type LiveVisualAudioFormat = Readonly<{
    encoding: "pcm-s16le";
    sampleRateHz: number;
    channels: number;
}>;
export type LiveVisualSessionOpenRequest = Readonly<{
    streamId: string;
    clock: Readonly<{
        unitsPerSecond: number;
    }>;
    video: Readonly<{
        width: number;
        height: number;
        frameRate: number;
    }>;
    audio?: LiveVisualAudioFormat;
}>;
export type LiveVisualInputEvent = Readonly<{
    type: "audio";
    pts: number;
    data: Uint8Array;
}> | Readonly<{
    type: "cue";
    pts: number;
    name: string;
    value: string | number | boolean;
}> | Readonly<{
    type: "flush";
    reason?: string;
}>;
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
export declare function createLobsterLiveVisualProvider(options?: AvatarRendererOptions): LiveVisualProvider;
