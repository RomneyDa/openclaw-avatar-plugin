export const CANONICAL_VISEMES = [
  "sil",
  "PP",
  "FF",
  "TH",
  "DD",
  "kk",
  "CH",
  "SS",
  "nn",
  "RR",
  "aa",
  "E",
  "I",
  "O",
  "U",
] as const;

export type CanonicalViseme = (typeof CANONICAL_VISEMES)[number];
export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type AvatarClearReason = "barge-in" | "cancel" | "replace" | "hangup" | "error";

export const AVATAR_AUDIO_FORMAT = {
  encoding: "pcm16le",
  sampleRateHz: 24_000,
  channels: 1,
} as const;

export type AvatarSessionDescription = {
  sessionId: string;
  generation: number;
  audio: typeof AVATAR_AUDIO_FORMAT;
  video: { width: number; height: number; frameRate: number };
};

export type AvatarEvent =
  | ({ type: "session.start" } & AvatarSessionDescription)
  | { type: "audio"; generation: number; sequence: number; ptsMs: number; pcm: Uint8Array }
  | {
      type: "visemes";
      generation: number;
      sequence: number;
      ptsMs: number;
      weights: Partial<Record<CanonicalViseme, number>>;
    }
  | { type: "state"; generation: number; ptsMs: number; state: AvatarState }
  | {
      type: "expression";
      generation: number;
      ptsMs: number;
      name: string;
      intensity: number;
      transitionMs: number;
    }
  | { type: "clear"; generation: number; reason: AvatarClearReason }
  | { type: "session.end"; generation: number; reason: string };

export type AvatarEventValidationOptions = {
  maxAudioChunkBytes?: number;
  maxPtsMs?: number;
};

const VISEMES = new Set<string>(CANONICAL_VISEMES);
const STATES = new Set<string>(["idle", "listening", "thinking", "speaking", "error"]);
const CLEAR_REASONS = new Set<string>(["barge-in", "cancel", "replace", "hangup", "error"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be finite and from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function generation(value: unknown): number {
  return integer(value, "generation", 0, 0x7fff_ffff);
}

function pts(value: unknown, options: AvatarEventValidationOptions): number {
  return finite(value, "ptsMs", 0, options.maxPtsMs ?? 86_400_000);
}

export function validateAvatarEvent(
  value: unknown,
  options: AvatarEventValidationOptions = {},
): AvatarEvent {
  const event = record(value, "avatar event");
  const type = event.type;
  if (typeof type !== "string") {
    throw new TypeError("avatar event type is required");
  }

  if (type === "session.start") {
    const audio = record(event.audio, "audio format");
    const video = record(event.video, "video format");
    if (
      audio.encoding !== AVATAR_AUDIO_FORMAT.encoding ||
      audio.sampleRateHz !== AVATAR_AUDIO_FORMAT.sampleRateHz ||
      audio.channels !== AVATAR_AUDIO_FORMAT.channels
    ) {
      throw new TypeError("audio format must be PCM16LE, 24000 Hz, mono");
    }
    return {
      type,
      sessionId: boundedString(event.sessionId, "sessionId"),
      generation: generation(event.generation),
      audio: AVATAR_AUDIO_FORMAT,
      video: {
        width: integer(video.width, "video.width", 16, 4096),
        height: integer(video.height, "video.height", 16, 4096),
        frameRate: finite(video.frameRate, "video.frameRate", 1, 120),
      },
    };
  }

  if (type === "audio") {
    if (!(event.pcm instanceof Uint8Array)) {
      throw new TypeError("audio.pcm must be a Uint8Array");
    }
    const max = options.maxAudioChunkBytes ?? 96_000;
    if (event.pcm.byteLength === 0 || event.pcm.byteLength > max || event.pcm.byteLength % 2 !== 0) {
      throw new TypeError(`audio.pcm must contain 1 to ${max / 2} complete PCM16LE samples`);
    }
    return {
      type,
      generation: generation(event.generation),
      sequence: integer(event.sequence, "sequence"),
      ptsMs: pts(event.ptsMs, options),
      pcm: event.pcm,
    };
  }

  if (type === "visemes") {
    const input = record(event.weights, "viseme weights");
    const weights: Partial<Record<CanonicalViseme, number>> = {};
    for (const [name, weight] of Object.entries(input)) {
      if (!VISEMES.has(name)) {
        throw new TypeError(`unknown canonical viseme: ${name}`);
      }
      weights[name as CanonicalViseme] = finite(weight, `viseme.${name}`, 0, 1);
    }
    return {
      type,
      generation: generation(event.generation),
      sequence: integer(event.sequence, "sequence"),
      ptsMs: pts(event.ptsMs, options),
      weights,
    };
  }

  if (type === "state") {
    if (typeof event.state !== "string" || !STATES.has(event.state)) {
      throw new TypeError("invalid avatar state");
    }
    return {
      type,
      generation: generation(event.generation),
      ptsMs: pts(event.ptsMs, options),
      state: event.state as AvatarState,
    };
  }

  if (type === "expression") {
    return {
      type,
      generation: generation(event.generation),
      ptsMs: pts(event.ptsMs, options),
      name: boundedString(event.name, "expression.name", 64),
      intensity: finite(event.intensity, "expression.intensity", 0, 1),
      transitionMs: finite(event.transitionMs, "expression.transitionMs", 0, 10_000),
    };
  }

  if (type === "clear") {
    if (typeof event.reason !== "string" || !CLEAR_REASONS.has(event.reason)) {
      throw new TypeError("invalid clear reason");
    }
    return {
      type,
      generation: generation(event.generation),
      reason: event.reason as AvatarClearReason,
    };
  }

  if (type === "session.end") {
    return {
      type,
      generation: generation(event.generation),
      reason: boundedString(event.reason, "session.end reason", 256),
    };
  }

  throw new TypeError(`unknown avatar event type: ${type}`);
}

export function isAvatarMediaEvent(event: AvatarEvent): event is Extract<AvatarEvent, { type: "audio" | "visemes" }> {
  return event.type === "audio" || event.type === "visemes";
}
