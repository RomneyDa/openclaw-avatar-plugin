import {
  AVATAR_AUDIO_FORMAT,
  type AvatarClearReason,
  type AvatarEvent,
  type AvatarState,
  type CanonicalViseme,
  isAvatarMediaEvent,
  validateAvatarEvent,
} from "./events.js";

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

type QueueEntry = { event: AvatarEvent; mediaBytes: number };

class SubscriberQueue {
  readonly id: string;
  readonly handler: AvatarSubscriber;
  readonly options: Required<Pick<AvatarSessionOptions, "maxSubscriberMediaBytes" | "maxSubscriberMediaEvents" | "maxSubscriberControlEvents">>;
  readonly metrics: AvatarSessionMetrics;
  readonly onError?: AvatarSessionOptions["onSubscriberError"];
  queue: QueueEntry[] = [];
  queuedMediaBytes = 0;
  active = true;
  draining = false;

  constructor(params: {
    id: string;
    handler: AvatarSubscriber;
    options: SubscriberQueue["options"];
    metrics: AvatarSessionMetrics;
    onError?: AvatarSessionOptions["onSubscriberError"];
  }) {
    this.id = params.id;
    this.handler = params.handler;
    this.options = params.options;
    this.metrics = params.metrics;
    this.onError = params.onError;
  }

  enqueue(event: AvatarEvent): boolean {
    if (!this.active) return false;
    const mediaBytes = event.type === "audio" ? event.pcm.byteLength : event.type === "visemes" ? 1 : 0;
    if (isAvatarMediaEvent(event)) {
      const mediaEvents = this.queue.reduce(
        (count, queued) => count + (isAvatarMediaEvent(queued.event) ? 1 : 0),
        0,
      );
      if (
        mediaEvents >= this.options.maxSubscriberMediaEvents ||
        this.queuedMediaBytes + mediaBytes > this.options.maxSubscriberMediaBytes
      ) {
        this.metrics.droppedMediaEvents += 1;
        this.metrics.droppedMediaBytes += event.type === "audio" ? event.pcm.byteLength : 0;
        return false;
      }
    } else {
      if (event.type === "clear" || event.type === "session.end") {
        const retained: QueueEntry[] = [];
        for (const queued of this.queue) {
          if (queued.event.generation < event.generation && isAvatarMediaEvent(queued.event)) {
            this.metrics.droppedMediaEvents += 1;
            this.metrics.droppedMediaBytes += queued.event.type === "audio" ? queued.event.pcm.byteLength : 0;
            this.queuedMediaBytes -= queued.mediaBytes;
          } else {
            retained.push(queued);
          }
        }
        this.queue = retained;
      }
      const controls = this.queue.reduce(
        (count, queued) => count + (isAvatarMediaEvent(queued.event) ? 0 : 1),
        0,
      );
      if (controls >= this.options.maxSubscriberControlEvents) {
        this.fail(new Error(`subscriber control queue exceeded ${this.options.maxSubscriberControlEvents} events`));
        return false;
      }
    }

    this.queue.push({ event, mediaBytes });
    this.queuedMediaBytes += mediaBytes;
    this.updateDepthMetrics();
    void this.drain();
    return true;
  }

  stop(): void {
    this.active = false;
    this.queue = [];
    this.queuedMediaBytes = 0;
    this.updateDepthMetrics();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.active) return;
    this.draining = true;
    try {
      while (this.active) {
        const entry = this.queue.shift();
        if (!entry) break;
        this.queuedMediaBytes -= entry.mediaBytes;
        this.updateDepthMetrics();
        await this.handler(entry.event);
        this.metrics.deliveredEvents += 1;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.draining = false;
      if (this.active && this.queue.length > 0) void this.drain();
    }
  }

  private fail(error: Error): void {
    if (!this.active) return;
    this.metrics.subscriberFailures += 1;
    this.stop();
    this.onError?.(this.id, error);
  }

  private updateDepthMetrics(): void {
    // The owning session recalculates aggregate values after publication; these
    // assignments keep snapshots moving while an async subscriber drains.
    this.metrics.queueDepth = Math.max(0, this.metrics.queueDepth);
    this.metrics.queuedMediaBytes = Math.max(0, this.metrics.queuedMediaBytes);
  }
}

export class AvatarSession {
  readonly options: Required<Pick<AvatarSessionOptions, "maxAudioChunkBytes" | "maxSubscriberMediaBytes" | "maxSubscriberMediaEvents" | "maxSubscriberControlEvents">> &
    Pick<AvatarSessionOptions, "onSubscriberError">;
  readonly subscribers = new Map<string, SubscriberQueue>();
  readonly metrics: AvatarSessionMetrics = {
    generation: 0,
    currentState: "idle",
    subscribers: 0,
    inputAudioBytes: 0,
    visemeFrames: 0,
    controlEvents: 0,
    deliveredEvents: 0,
    droppedMediaEvents: 0,
    droppedMediaBytes: 0,
    subscriberFailures: 0,
    queueDepth: 0,
    queuedMediaBytes: 0,
  };
  #active = false;
  #sessionId: string | null = null;
  #sequence = 0;
  #video = { width: 1280, height: 720, frameRate: 30 };

  constructor(options: AvatarSessionOptions = {}) {
    this.options = {
      maxAudioChunkBytes: options.maxAudioChunkBytes ?? 96_000,
      maxSubscriberMediaBytes: options.maxSubscriberMediaBytes ?? 1_048_576,
      maxSubscriberMediaEvents: options.maxSubscriberMediaEvents ?? 128,
      maxSubscriberControlEvents: options.maxSubscriberControlEvents ?? 32,
      ...(options.onSubscriberError ? { onSubscriberError: options.onSubscriberError } : {}),
    };
  }

  subscribe(id: string, handler: AvatarSubscriber): () => void {
    if (!id || this.subscribers.has(id)) throw new Error(`avatar subscriber id is invalid or duplicated: ${id}`);
    const subscriber = new SubscriberQueue({
      id,
      handler,
      options: this.options,
      metrics: this.metrics,
      ...(this.options.onSubscriberError ? { onError: this.options.onSubscriberError } : {}),
    });
    this.subscribers.set(id, subscriber);
    this.metrics.subscribers = this.subscribers.size;
    return () => {
      subscriber.stop();
      this.subscribers.delete(id);
      this.recalculateQueueMetrics();
    };
  }

  start(params: {
    sessionId: string;
    generation?: number;
    video?: { width: number; height: number; frameRate: number };
  }): void {
    if (this.#active) throw new Error("avatar session is already active");
    this.#active = true;
    this.#sessionId = params.sessionId;
    this.#sequence = 0;
    if (params.generation !== undefined) this.metrics.generation = params.generation;
    if (params.video) this.#video = { ...params.video };
    this.metrics.currentState = "idle";
    this.publish({
      type: "session.start",
      sessionId: params.sessionId,
      generation: this.metrics.generation,
      audio: AVATAR_AUDIO_FORMAT,
      video: this.#video,
    });
  }

  audio(pcm: Uint8Array, ptsMs: number): boolean {
    this.requireActive();
    if (this.metrics.currentState !== "speaking") this.state("speaking", ptsMs);
    this.metrics.inputAudioBytes += pcm.byteLength;
    return this.publish({
      type: "audio",
      generation: this.metrics.generation,
      sequence: this.#sequence++,
      ptsMs,
      pcm,
    });
  }

  audioFromSource(params: {
    pcm: Uint8Array;
    ptsMs: number;
    generation: number;
    sequence: number;
  }): boolean {
    this.requireActive();
    if (params.generation !== this.metrics.generation) return false;
    this.metrics.currentState = "speaking";
    this.metrics.inputAudioBytes += params.pcm.byteLength;
    this.#sequence = Math.max(this.#sequence, params.sequence + 1);
    return this.publish({ type: "audio", ...params });
  }

  visemes(weights: Partial<Record<CanonicalViseme, number>>, ptsMs: number): boolean {
    this.requireActive();
    this.metrics.visemeFrames += 1;
    return this.publish({
      type: "visemes",
      generation: this.metrics.generation,
      sequence: this.#sequence++,
      ptsMs,
      weights,
    });
  }

  state(state: AvatarState, ptsMs: number): void {
    this.requireActive();
    this.metrics.currentState = state;
    this.publish({ type: "state", generation: this.metrics.generation, ptsMs, state });
  }

  stateFromSource(state: AvatarState, ptsMs: number, generation: number): boolean {
    this.requireActive();
    if (generation !== this.metrics.generation) return false;
    this.metrics.currentState = state;
    this.publish({ type: "state", generation, ptsMs, state });
    return true;
  }

  expression(name: string, intensity: number, transitionMs: number, ptsMs: number): void {
    this.requireActive();
    this.publish({
      type: "expression",
      generation: this.metrics.generation,
      ptsMs,
      name,
      intensity,
      transitionMs,
    });
  }

  clear(reason: AvatarClearReason): number {
    this.requireActive();
    this.metrics.generation += 1;
    this.#sequence = 0;
    this.publish({ type: "clear", generation: this.metrics.generation, reason });
    return this.metrics.generation;
  }

  clearFromSource(reason: AvatarClearReason, generation: number): boolean {
    this.requireActive();
    if (generation <= this.metrics.generation) return false;
    this.metrics.generation = generation;
    this.#sequence = 0;
    this.publish({ type: "clear", generation, reason });
    return true;
  }

  end(reason: string): void {
    if (!this.#active) return;
    this.clear(reason === "error" ? "error" : "hangup");
    this.metrics.currentState = reason === "error" ? "error" : "idle";
    this.publish({ type: "session.end", generation: this.metrics.generation, reason });
    this.#active = false;
    this.#sessionId = null;
  }

  endFromSource(reason: string, generation: number): boolean {
    if (!this.#active || generation !== this.metrics.generation) return false;
    this.metrics.currentState = reason === "error" ? "error" : "idle";
    this.publish({ type: "session.end", generation, reason });
    this.#active = false;
    this.#sessionId = null;
    return true;
  }

  snapshot(): AvatarSessionMetrics & { active: boolean; sessionId: string | null } {
    this.recalculateQueueMetrics();
    return { ...this.metrics, active: this.#active, sessionId: this.#sessionId };
  }

  private publish(input: AvatarEvent): boolean {
    const event = validateAvatarEvent(input, { maxAudioChunkBytes: this.options.maxAudioChunkBytes });
    if (!isAvatarMediaEvent(event)) this.metrics.controlEvents += 1;
    let accepted = false;
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.active) {
        this.subscribers.delete(id);
        continue;
      }
      accepted = subscriber.enqueue(event) || accepted;
    }
    this.metrics.subscribers = this.subscribers.size;
    this.recalculateQueueMetrics();
    return accepted;
  }

  private recalculateQueueMetrics(): void {
    let queueDepth = 0;
    let queuedMediaBytes = 0;
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.active) {
        this.subscribers.delete(id);
        continue;
      }
      queueDepth += subscriber.queue.length;
      queuedMediaBytes += subscriber.queuedMediaBytes;
    }
    this.metrics.subscribers = this.subscribers.size;
    this.metrics.queueDepth = queueDepth;
    this.metrics.queuedMediaBytes = queuedMediaBytes;
  }

  private requireActive(): void {
    if (!this.#active) throw new Error("avatar session is not active");
  }
}
