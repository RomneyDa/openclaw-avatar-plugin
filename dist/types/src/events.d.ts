export declare const CANONICAL_VISEMES: readonly ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"];
export type CanonicalViseme = (typeof CANONICAL_VISEMES)[number];
export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type AvatarClearReason = "barge-in" | "cancel" | "replace" | "hangup" | "error";
export declare const AVATAR_AUDIO_FORMAT: {
    readonly encoding: "pcm16le";
    readonly sampleRateHz: 24000;
    readonly channels: 1;
};
export type AvatarSessionDescription = {
    sessionId: string;
    generation: number;
    audio: typeof AVATAR_AUDIO_FORMAT;
    video: {
        width: number;
        height: number;
        frameRate: number;
    };
};
export type AvatarEvent = ({
    type: "session.start";
} & AvatarSessionDescription) | {
    type: "audio";
    generation: number;
    sequence: number;
    ptsMs: number;
    pcm: Uint8Array;
} | {
    type: "visemes";
    generation: number;
    sequence: number;
    ptsMs: number;
    weights: Partial<Record<CanonicalViseme, number>>;
} | {
    type: "state";
    generation: number;
    ptsMs: number;
    state: AvatarState;
} | {
    type: "expression";
    generation: number;
    ptsMs: number;
    name: string;
    intensity: number;
    transitionMs: number;
} | {
    type: "clear";
    generation: number;
    reason: AvatarClearReason;
} | {
    type: "session.end";
    generation: number;
    reason: string;
};
export type AvatarEventValidationOptions = {
    maxAudioChunkBytes?: number;
    maxPtsMs?: number;
};
export declare function validateAvatarEvent(value: unknown, options?: AvatarEventValidationOptions): AvatarEvent;
export declare function isAvatarMediaEvent(event: AvatarEvent): event is Extract<AvatarEvent, {
    type: "audio" | "visemes";
}>;
