# OpenClaw Avatar Architecture and Implementation Plan

Status: proposed architecture informed by the 2026-07-16 FaceTime/OBS prototypes and the
2026-07-17 OpenAI Realtime transport proof.

This document supersedes the renderer-specific direction in `PLAN.md`. The current TalkingHead
prototype remains useful evidence, but it is not the intended long-term OpenClaw avatar
architecture.

## Executive decision

OpenClaw should treat an avatar as a media surface driven by a canonical, timed stream of audio,
visemes, conversational state, and lifecycle controls. The avatar must not belong to the FaceTime
channel, to OBS, or to any particular model format.

There are two independent plug points:

1. A renderer backend consumes semantic avatar events and renders a visual surface. Initial
   backends should be Rive and VRM; Inochi2D and neural portrait renderers can be native sidecars.
2. A video sink publishes that surface to a destination. Initial sinks should be preview/canvas,
   WebRTC, and OBS; native virtual-camera sinks can follow.

There is also an internal media-source attachment boundary. It is not a third renderer/plugin
ecosystem: it adapts whichever component owns the active voice session into the canonical avatar
event stream. Browser-owned WebRTC sessions and Gateway-owned relay/channel sessions require
different adapters because their audio exists in different processes.

The default renderer should be a lightweight, deliberately designed 2D Rive character. Rive's web
runtime is MIT licensed, its `canvas-lite` WASM is approximately 707 KB uncompressed and 222 KB
Brotli-compressed, and attractive interactive character files can be well below 200 KB. The
[Bob lip-sync character](https://rive.app/marketplace/28111-53105-bob-lip-sync-character-system-in-rive/)
is a strong CC BY demonstration asset at 169,578 bytes. It is suitable for a proof, not necessarily
as OpenClaw's permanent identity. The permanent default should be original artwork with clear
redistribution rights.

The implementation must make a clean cut to the new architecture. Do not preserve
`FaceTimeAvatar*` names through aliases, re-exports, duplicate config shapes, or compatibility
wrappers.

## Goals

- Drive a visually appealing character from the exact audio OpenClaw sends to a caller.
- Support Rive, VRM, Inochi2D, neural portrait, and future renderers without changing channel code.
- Support browser/WebRTC output without installing OBS or an operating-system camera driver.
- Support native applications such as FaceTime and Zoom through OBS initially and native virtual
  camera packages later.
- Keep audio and video synchronized through a shared media clock and atomic clear semantics.
- Stop mouth motion immediately on barge-in, cancellation, call replacement, and hangup.
- Permit npm distribution even when an implementation uses Rust, Swift, C, C++, D, or another
  native language.
- Ship one attractive, permissively licensed default character while allowing operator-selected
  assets.
- Preserve audio-only calling when any avatar component fails.
- Keep media local by default and retain no raw audio, frames, portraits, or embeddings.

## Non-goals

- Reimplement a general-purpose 3D engine before a concrete renderer requires it.
- Make model loaders independently pluggable from their renderer.
- Force every renderer to infer visemes from audio.
- Force every native sidecar through N-API.
- Hide operating-system approval, signing, or driver-installation requirements behind npm scripts.
- Support old operating systems solely to preserve compatibility. A first native Windows camera
  may require Windows 11, and the first macOS camera may require the current Camera Extension API.
- Treat a successful model decode or WebSocket connection as proof that visible video exists.

## What the prototypes actually proved

### End-to-end status

The visible demos were not end-to-end OpenClaw agent runs. They used real code from this plugin's
avatar server, renderer, HeadAudio path, OBS browser source, and OBS Virtual Camera, but a preview
harness injected synthetic or prerecorded PCM directly. The following components were not in the
demo path:

- OpenClaw Gateway startup and plugin loading.
- An OpenClaw agent response.
- A realtime provider session.
- A live FaceTime call.
- Provider barge-in and its corresponding clear event.

The intended plugin path exists: realtime provider PCM reaches `FaceTimeOutputPacer`, which sends
the same PCM to the avatar immediately and to BlackHole after a configurable delay. That complete
path still needs a live proof.

### OpenAI Realtime transport findings

The OpenAI Realtime configuration proof successfully loaded the OpenAI provider, selected
`gpt-realtime-2.1`, and created a client-owned WebRTC session through `talk.client.create`. The
Gateway minted the short-lived client secret, but the browser then negotiated WebRTC directly with
OpenAI. Creating the session proved provider configuration and credential flow; it did not by
itself prove that live output audio reached the current avatar prototype.

Code inspection established two distinct media ownership paths:

1. In direct WebRTC mode, assistant audio arrives in the Control UI as a remote `MediaStream` track.
   The Gateway and ordinary OpenClaw plugins do not receive those decoded samples. The same browser
   session also receives provider data-channel events for transcripts and lifecycle.
2. In `gateway-relay` and channel-owned sessions, the provider bridge sends exact output buffers to
   `RealtimeVoiceAudioSink.sendAudio()` and interruption through `clearAudio()`. The Gateway or
   channel can fan those buffers out to playback and the avatar without another provider session.

Generic Talk events remain useful for normalized lifecycle, transcripts, tools, and diagnostics,
but they are not the media transport. An `output.audio.delta` Talk event may describe a chunk while
the owning WebRTC track or relay envelope carries the actual samples.

Therefore an avatar must attach to the existing voice session where its media lives. It must never
start a second realtime provider session merely to obtain lip-sync audio, and it must not depend on
a particular voice-provider plugin. The standard provider key and short-lived client secret remain
owned by the Gateway and realtime transport; avatar code receives neither credential.

### Demonstrated media path

```text
preview PCM
  -> FaceTimeAvatarServer loopback WebSocket
  -> browser AudioContext
  -> HeadAudio AudioWorklet
  -> TalkingHead / Three.js renderer
  -> OBS browser source
  -> OBS Virtual Camera
  -> Photo Booth
```

The renderer and WebSocket were loopback-only and token-authenticated. The browser did not connect
the analysis audio graph to a physical audio output. OBS was configured through authenticated
localhost `obs-websocket` and used a dedicated scene and browser source.

### Lip-sync findings

- HeadAudio accepts arbitrary audio and emits the 15 Oculus-style values used by TalkingHead:
  `sil`, `PP`, `FF`, `TH`, `DD`, `kk`, `CH`, `SS`, `nn`, `RR`, `aa`, `E`, `I`, `O`, and `U`.
- The procedural placeholder rendered only a small composite of the available visemes. It therefore
  appeared closed during sounds that should have produced visible consonant shapes.
- The MPFB GLB contained all 14 non-silence viseme targets, but audio-only classification still
  missed or smoothed some speech. A classifier cannot be more precise than provider-supplied timed
  phonemes or visemes.
- When a TTS/realtime provider exposes timed phonemes or visemes, OpenClaw should prefer them. The
  audio classifier remains the fallback for arbitrary PCM.
- Viseme smoothing must be renderer-independent and bounded. Over-smoothing produces a
  ventriloquist effect; under-smoothing produces chatter.
- `clear` must reset audio scheduling, classifier state, interpolation, and all visible mouth
  weights atomically.

### MPFB asset findings

The open MakeHuman/MPFB demonstration model was CC0, but it was a poor runtime asset and an
especially poor default aesthetic.

The original GLB was 36,815,920 bytes. Inspection found:

- Seven embedded PNG textures totaling approximately 19.4 MB.
- A 4096x4096 suit normal texture despite a head-framed camera.
- A full body, suit, ponytail, teeth, tongue, eyebrows, eyelashes, and skeleton.
- A base mesh with 11,779 uploaded vertices and 66 morph targets.
- Eyebrows with 12,243 vertices and 23 morph targets.
- Eyelashes with 16,992 vertices and 33 morph targets.
- Teeth with 4,494 uploaded vertices, 12 morph targets, and a 2048x2048 texture.
- No geometry compression, quantization, or modern texture compression.
- An estimated decoded GPU footprint above 200 MB once textures and geometry expand.

Large data did not produce high visual quality. The model had basic skin material, crude hair,
awkward teeth, and limited shading. The demo also explicitly selected `body: "F"`, and the texture
was named `young_lightskinned_female_diffuse2`; the apparent gender was not chosen dynamically by
OpenClaw.

The white-model failure was not missing colors. Embedded GLB images were exposed as `blob:` URLs,
and the renderer CSP initially blocked those URLs. Allowing `blob:` in `connect-src` fixed the
textures.

The idle wandering came from TalkingHead's default eye, head, and pose movement. Setting idle and
speaking head movement to zero, fixing eye contact, and setting the model movement factor to zero
made the camera substantially steadier.

### Asset optimization experiments

Several different optimizations were tried and must not be conflated:

1. A generic glTF Transform pass reduced 36.82 MB to approximately 2.8 MB with 1024px WebP,
   quantization, and Meshopt. Its default flattening removed TalkingHead's required `Armature`
   object, so TalkingHead rejected it.
2. A custom physical neck crop produced a validator-clean GLB but rendered no visible geometry.
   Editing a skinned primitive without rebuilding all rig assumptions was not safe.
3. Removing unused morph targets also produced a validator-clean GLB that TalkingHead reported as
   ready but rendered blank. TalkingHead and/or this MakeHuman rig relied on relationships beyond
   the apparent target list.
4. A rig-preserving transform removed the suit mesh and its textures, retained the original skeleton
   and morph targets, converted textures to 1024px WebP, and applied Meshopt without flattening. It
   produced a visible 2.7 MB asset.

The final 2.7 MB experiment is a useful fallback and proves that 37 MB was unnecessary. It still
contains hidden body geometry because the reliable optimization preserved the rig; only the camera
presentation is head-only. It is not the recommended default renderer.

Meshopt required a decoder that TalkingHead does not register. The prototype patched the shared
Three.js `GLTFLoader` prototype to register `MeshoptDecoder`. Meshopt uses WebAssembly, requiring the
targeted CSP source `'wasm-unsafe-eval'`; broad `'unsafe-eval'` is not necessary.

### Readiness finding

A renderer twice reported `ready` while showing only a blank background. Readiness must therefore
mean all of the following:

1. Transport connected.
2. Runtime initialized.
3. Asset decoded and validated.
4. First frame was presented.
5. The presented surface contains expected non-background output.

Automated smoke tests must capture and inspect a frame. A status message alone is insufficient.

### Current size measurements

On the prototype checkout:

- HeadAudio installed size: approximately 160 KB.
- HeadAudio worklet plus model copied into `dist`: approximately 32 KB.
- TalkingHead installed size: approximately 424 KB.
- Three.js installed size: approximately 32 MB.
- Original bundled avatar JavaScript: approximately 812 KB.
- Bundle analysis attributed roughly two-thirds of that JavaScript to Three.js core.
- Adding Meshopt raised the browser bundle to approximately 929 KB.
- The optimized experimental GLB is approximately 2.7 MB.
- Package verification with an intermediate 1.2 MB cropped asset produced an approximately 2.7 MB
  npm archive; that measurement is not a final package-size claim.

Replacing TalkingHead alone does not eliminate the majority of a 3D renderer; Three.js remains the
dominant JavaScript cost. Replacing 3D with a purpose-built 2D renderer does.

## Renderer research

### Rive: recommended default

[Rive's web runtime](https://github.com/rive-app/rive-wasm) is MIT licensed and available through
npm. The runtime renders interactive vector/raster characters into a canvas and supports state
machines and data binding. The editor/service is not an open-source toolchain, but exported `.riv`
files can be bundled and the production runtimes are open source.

`@rive-app/canvas-lite` is the preferred package for an avatar that does not require Rive text,
layout, audio, or scripting. Rive documents the WASM portion at approximately 707 KB uncompressed
and 222 KB Brotli-compressed. The 2.38.5 npm tarball measured approximately 787 KB compressed and
2.44 MB unpacked, including normal and fallback WASM variants.

Promising CC BY marketplace assets measured during research:

| Asset | Approximate `.riv` size | Notes |
| --- | ---: | --- |
| [Bob lip-sync character](https://rive.app/marketplace/28111-53105-bob-lip-sync-character-system-in-rive/) | 170 KB | Layered visemes, expressions, triggers, and outfit swaps; best immediate demo candidate |
| [Character face animation](https://rive.app/community/files/4532-9211-character-face-animation/) | 170 KB | Attractive bearded cartoon head; speaking face animation |
| [Bone-based lip-sync character](https://rive.app/marketplace/20725-39009-bone-based-lipsync-character-animation/) | 49 KB | Very small bone-driven demonstration |
| [Custom talking avatar](https://rive.app/marketplace/21097-39720-custom-talking-avatar-real-time-lip-sync-for-your-app/) | 816 KB | Explicit phoneme/viseme demonstration |
| [Gargoyle avatar](https://www.rive.app/marketplace/25582-47749-gargoyle-avatar/) | 2.56 MB | Data-bound visemes, AI-generated raster-heavy art |

Rive Marketplace files are published under CC BY. A shipped marketplace asset therefore requires
recorded attribution. The production default should preferably be commissioned or generated as
original OpenClaw artwork, with source files retained and an explicit permissive license.

Why Rive is preferred:

- The aesthetic is intentionally animated rather than accidentally uncanny.
- Vector mouth shapes avoid teeth, skin, and shading artifacts.
- Visemes and expressions are first-class state-machine/data-binding values.
- Idle behavior is authored and can be completely disabled or limited to blinking.
- Canvas output works with preview, OBS, `captureStream()`, and WebRTC.
- Runtime plus asset can be below 1 MB compressed.
- It removes Three.js, GLTFLoader, TalkingHead, Meshopt, the GLB, and most 3D-specific code.

### VRM: recommended optional 3D backend

[VRM](https://vrm-consortium.org/en/) is an open humanoid-avatar format based on glTF. It
standardizes scale, skeletons, expressions, gaze, spring bones, toon materials, and embedded model
license metadata. [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) is MIT licensed and
available through npm.

VRM is a better 3D contract than TalkingHead-specific GLBs. It provides standardized vowel
expressions (`aa`, `ih`, `ou`, `ee`, `oh`) and blink/gaze controls. A VRM backend can map the 15
canonical OpenClaw visemes into those expressions.

[Open Source Avatars](https://github.com/toxsam/open-source-avatars) provides a developer-readable
registry with direct VRM downloads, thumbnails, and per-collection licensing, including hundreds of
CC0 avatars. VRoid also published older sample models under CC0.

VRM remains a 3D solution. It retains Three.js/WebGPU/WebGL, model textures, toon materials, and
larger assets. It should be optional rather than the default performance baseline.

### Inochi2D: native open-source puppet backend

[Inochi2D](https://github.com/Inochi2D/inochi2d) is BSD-2-Clause and provides a fully open realtime
2D puppet format, runtime, and open-source rigging application. It offers Live2D-like layered mesh
deformation without Live2D's proprietary core.

Its reference runtime is written in D and exposes a C FFI. It does not currently provide the simple
npm/browser path that Rive provides. OpenClaw could ship it as a prebuilt native sidecar, or wrap it
with Rust/C bindings, but that is a later integration project.

### OpenClaw-native SVG/sprite renderer

A minimal original renderer could use SVG or layered PNG/WebP assets with authored mouth shapes,
eyes, brows, and a small state machine. The same asset manifest could be rendered in a browser and
by a Rust `resvg`/raster sidecar. This would provide the smallest fully controlled and fully open
stack, likely below 500 KB including artwork.

The cost is original art and rigging work. Rive is the faster way to validate the product
experience; an OpenClaw-native format should be considered only after the desired visual language
is established.

### Rejected or deferred renderers

- Live2D looks polished but uses proprietary core technology and restrictive model/tool licensing.
- Spine has proprietary editor/runtime licensing.
- Lottie and dotLottie are efficient for linear animation but provide a weaker interactive puppet
  model than Rive.
- Talking Head Anime 4 and related neural anime models can animate a portrait but introduce model
  runtimes, GPU/CPU cost, and larger distribution.
- MuseTalk and Ditto remain possible Linux/NVIDIA sidecars for photorealistic portraits.
- LivePortrait is motion/video-driven rather than directly audio-driven.
- Wav2Lip's open release is noncommercial and batch-oriented.
- AVTR-1 has noncommercial and transitive model-license constraints.

## Required OpenClaw architecture

### Layering

```text
Direct WebRTC                         Gateway relay / native channel
provider -> browser remote track      provider -> RealtimeVoiceAudioSink
                    |                                  |
                    +-------- media-source adapter ----+
                                       |
                                       v
        Avatar session core
        - media clock
        - bounded fanout
        - lifecycle and clear generation
        - optional viseme inference
              |
              | AvatarEvent stream
              v
        Renderer backend
        - Rive browser renderer
        - VRM browser renderer
        - Inochi native sidecar
        - neural native/remote sidecar
              |
              | browser canvas or native frame stream
              v
          Video sink
        - preview
        - WebRTC
        - OBS browser source
        - native virtual camera
```

The channel owns call control and the audio-device path. It does not own avatar rendering. The
avatar core observes the same outgoing PCM that the caller hears.

### Session attachment and transport ownership

The first implementation needs two internal source adapters behind one avatar-session input:

- `BrowserWebRtcAvatarSource` attaches to the remote output `MediaStream` already created by the
  Control UI's `RealtimeTalkSession`. It analyzes the same decoded track used for playback and
  converts it to the canonical format once at the browser boundary.
- `GatewayAvatarSource` wraps or composes the active `RealtimeVoiceAudioSink`. It fans provider PCM
  and clear lifecycle to the transport/device sink and avatar subscribers without allowing either
  subscriber to block the other.

The adapters normalize media and lifecycle; they are not independently selected provider plugins.
Renderer and sink selection remain the two public avatar plug points. A voice provider needs no
knowledge of Rive, OBS, FaceTime, or a virtual camera.

### OpenClaw media tap

The current FaceTime plugin already has raw PCM at `FaceTimeOutputPacer`. That is the immediate
integration point.

For an upstream OpenClaw implementation, generic Talk lifecycle events must not be assumed to carry
the actual audio bytes. Existing `output.audio.delta` events may contain only metadata such as byte
length, while the owning WebRTC track or relay carries audio separately. OpenClaw needs an
attachment at the owning transport: the browser remote track for direct WebRTC, and a first-class
output media tap at the audio sink/provider bridge for Gateway-owned sessions. It must not create a
second provider connection or copy every PCM chunk into a generic JSON event.

Each source adapter must provide:

- The exact output samples available at its owning playback boundary.
- Format metadata.
- Monotonic sequence and media timestamps.
- Start, done, cancellation, replacement, and clear lifecycle.
- A bounded subscriber API whose failure cannot block agent audio.

### Canonical media format

The avatar session uses the format already required by the FaceTime realtime bridge:

- Signed PCM16 little-endian.
- 24,000 Hz.
- Mono.
- Timestamp unit: milliseconds from the current output generation's media clock.

Gateway-owned OpenAI sessions already provide this format. A browser WebRTC track may be decoded at
the browser's audio-context rate, commonly 48 kHz; `BrowserWebRtcAvatarSource` resamples it once to
the canonical format. Renderers must not each repeat that conversion.

### Canonical viseme vocabulary

The canonical vocabulary is:

```text
sil PP FF TH DD kk CH SS nn RR aa E I O U
```

Weights are finite floating-point numbers clamped to `[0, 1]`. A frame may contain multiple active
weights. Backends map this vocabulary into their own controls:

- Rive may use all 15 values.
- VRM maps into its five vowel expressions and optional jaw/mouth controls.
- Inochi2D maps into puppet parameters.
- Neural backends may ignore canonical weights and consume PCM.

### Event protocol

The protocol is the stable renderer plug point. Browser modules receive structured objects and
native sidecars receive the same schema over framed stdio or a local socket.

```ts
type AvatarEvent =
  | {
      type: "session.start";
      sessionId: string;
      generation: number;
      audio: { encoding: "pcm16le"; sampleRateHz: 24_000; channels: 1 };
      video: { width: number; height: number; frameRate: number };
    }
  | {
      type: "audio";
      generation: number;
      sequence: number;
      ptsMs: number;
      pcm: Uint8Array;
    }
  | {
      type: "visemes";
      generation: number;
      sequence: number;
      ptsMs: number;
      weights: Partial<Record<CanonicalViseme, number>>;
    }
  | {
      type: "state";
      generation: number;
      ptsMs: number;
      state: "idle" | "listening" | "thinking" | "speaking" | "error";
    }
  | {
      type: "expression";
      generation: number;
      ptsMs: number;
      name: string;
      intensity: number;
      transitionMs: number;
    }
  | {
      type: "clear";
      generation: number;
      reason: "barge-in" | "cancel" | "replace" | "hangup" | "error";
    }
  | {
      type: "session.end";
      generation: number;
      reason: string;
    };
```

Rules:

- `generation` increments on every clear/replacement boundary. A renderer discards events from an
  older generation.
- `sequence` is monotonic within a generation.
- `ptsMs` uses the media clock, never renderer wall-clock arrival time.
- Control events are never silently dropped.
- Audio and viseme queues are bounded. On overflow, drop media, report counters, and reset
  interpolation at the next accepted event.
- `clear` cancels scheduled audio analysis, resets visemes to `sil`, clears expressions that were
  tied to speech, and presents the neutral mouth within one rendered frame.
- PCM and canonical visemes are both available. Renderers ignore what they do not need.
- `AvatarEvent` is a bounded local renderer protocol, not a replacement for generic `TalkEvent` and
  not a broadcast of raw audio to arbitrary Gateway clients.

### Conversational state mapping

Source adapters derive the default face state without consulting the agent or starting another
model request:

- `session.ready` maps to `listening`.
- Input speech start maps to `listening` and clears stale speaking motion when it interrupts output.
- Input commit/speech stop and `response.created` map to `thinking`.
- The first accepted output audio sample maps to `speaking`; transcript text alone does not.
- Response completion/cancellation maps back to `listening` and clears scheduled mouth motion.
- Session close/error maps to `idle`/`error` and ends the avatar generation.

Transcripts may drive captions or later expression policy, but they are not a timing source for lip
sync.

### Lip-sync engine

One shared engine should produce canonical visemes. It is an internal seam, not a public plugin
ecosystem until a second implementation proves the need.

Priority order:

1. Provider/TTS timed visemes.
2. Provider/TTS timed phonemes mapped to canonical visemes.
3. Audio-driven inference from exact PCM.

The first audio fallback can remain HeadAudio for browser renderers. HeadAudio uses resampling,
MFCCs, VAD, a Gaussian prototype/Mahalanobis classifier, and a small model. Its MIT implementation
is feasible to port to Rust when native rendering requires a process-independent engine.

The engine owns attack/release smoothing and silence gating. Renderers may apply only minimal
visual interpolation and must not introduce unbounded latency.

### Renderer backend contract

Do not build class hierarchies for individual model formats. A renderer backend is one package with
one entry point and one lifecycle.

```ts
interface AvatarRendererModule {
  apiVersion: 1;
  id: string;
  runtime: "browser" | "sidecar";
  create(options: AvatarRendererOptions): Promise<AvatarRenderer>;
}

interface AvatarRenderer {
  start(session: AvatarSessionDescription): Promise<void>;
  handle(event: AvatarEvent): void;
  snapshot(): AvatarRendererSnapshot;
  stop(): Promise<void>;
}
```

For `browser` renderers, the host supplies the canvas and clock. The renderer draws into that canvas.
For `sidecar` renderers, `create` launches a signed/prebuilt executable and translates the same
events onto framed IPC. Sidecars must not receive provider credentials or unrelated OpenClaw state.

The renderer package owns:

- Its asset loader.
- Renderer-specific viseme mapping.
- Renderer-specific state/expression mapping.
- Asset validation.
- Rendering and first-frame readiness.
- Renderer-specific configuration schema.

The renderer package does not own:

- OpenClaw provider sessions.
- Channel call lifecycle.
- OBS or native camera selection.
- Caller audio output.
- Persistent media recording.

### Video sink contract

Renderer selection and video publication are independent.

Initial sink behavior:

- `preview`: display or capture the host canvas locally.
- `webrtc`: use `canvas.captureStream()` or WebCodecs/track generation and attach the video track to
  a browser/WebRTC session. This is the genuinely npm-only and driver-free path.
- `obs`: serve an authenticated loopback renderer URL, attach it as a dedicated OBS browser source,
  and control OBS Virtual Camera through authenticated localhost `obs-websocket`.
- `native-camera`: pass rendered frames to an npm-distributed native host that publishes the
  operating-system camera.

The first implementation does not need a universal raw-frame TypeScript abstraction. Browser
renderers share a host canvas. Native sidecars may later expose a shared-memory frame descriptor.

### Browser host

The browser host is renderer-neutral and owns:

- Loopback HTTP and authenticated WebSocket/event delivery.
- Attachment to the existing Control UI `RealtimeTalkSession` remote output track for direct
  WebRTC; the host must not mint another client secret or create another provider session.
- Canvas dimensions and device-pixel-ratio policy.
- AudioWorklet installation when browser lip-sync is selected.
- Mapping of realtime data-channel/Talk lifecycle into avatar state and atomic clear behavior.
- Renderer module loading.
- First-frame and surface-health reporting.
- `captureStream()` for direct browser/WebRTC sinks.
- CSP assembled from explicit renderer capabilities.
- Bounded event buffering and disconnect recovery.

The Rive backend must use `@rive-app/canvas-lite` unless the chosen asset requires excluded Rive
features. It must prefer current Rive data binding for original assets; legacy state-machine inputs
may be supported inside a specific marketplace-demo adapter, not exposed as the core contract.

### Configuration

The target configuration belongs to an OpenClaw avatar/media surface rather than under FaceTime.
Until OpenClaw exposes that surface, the FaceTime plugin may host the same shape without renaming it
through compatibility aliases later.

```json
{
  "avatar": {
    "enabled": true,
    "renderer": {
      "package": "@openclaw/avatar-rive",
      "asset": "./avatars/openclaw.riv",
      "options": {}
    },
    "lipSync": {
      "mode": "auto",
      "audioDelayMs": 80
    },
    "video": {
      "width": 1280,
      "height": 720,
      "frameRate": 30
    },
    "sink": {
      "type": "obs",
      "options": {
        "url": "ws://127.0.0.1:4455",
        "passwordEnv": "OBS_WEBSOCKET_PASSWORD"
      }
    }
  }
}
```

`renderer.package` may name an installed npm package or an explicitly allowed local package path.
Do not execute arbitrary package names received from callers or remote configuration. Config loading
must resolve packages from trusted OpenClaw configuration only.

Renderer-specific asset options stay under `renderer.options`. Do not add top-level Rive, VRM,
Inochi, or TalkingHead fields.

### Status and observability

Expose:

- Renderer package, version, runtime kind, and asset identifier/hash.
- Transport connected state.
- Runtime initialized state.
- Asset loaded state.
- First-frame timestamp and first-frame validation result.
- Current conversational state and media generation.
- Input audio bytes, viseme frames, rendered frames, and dropped counts.
- Render FPS, p50/p95 frame time, queue depth, and last renderer error.
- Estimated audio/video skew.
- Sink connection and virtual-camera state.
- Sidecar PID/version and crash/restart count where applicable.

No metric may contain raw audio, rendered frames, portrait data, credentials, or unredacted
filesystem URLs containing secrets.

## Native and Rust opportunities

An npm package may contain and spawn native binaries. Prefer a sidecar process with versioned framed
stdio or a local socket over N-API for system integrations because it provides crash isolation,
avoids Node ABI coupling, and separates signing/install lifecycle.

### Shared native core

Rust is a good fit for:

- Framed control/media IPC.
- Shared-memory ring buffers.
- PCM resampling and a future HeadAudio-compatible viseme engine.
- Pixel format conversion and scaling.
- A simple SVG/raster renderer.
- Windows virtual-camera registration and media-source hosting.
- Linux V4L2 and PipeWire userspace writers.
- Cross-platform diagnostics and installer orchestration.

Raw 1280x720 BGRA at 30 fps is approximately 110 MB/s. Do not stream it over JSON or ordinary
stdio. A native frame path should use shared memory, GPU sharing where practical, or a lower-bandwidth
pixel format such as NV12. Control events remain on framed stdio/socket IPC.

### macOS camera

The modern route is a CoreMediaIO Camera Extension. Apple packages Camera Extensions inside an app,
requires the host app in `/Applications`, and requires user/system approval. A thin Swift or
Objective-C extension should integrate with Apple's framework while Rust owns shared frame queues,
conversion, and protocol code through a C ABI.

The host app still needs an explicit frame producer. For a Gateway-owned session, the preferred
initial path is Gateway PCM/events to a native avatar renderer and then shared frames to the Swift
Camera Extension. A direct-WebRTC browser renderer instead needs a deliberate local video bridge,
such as `canvas.captureStream()` over a loopback WebRTC connection to the host app. Do not use
per-frame browser screenshots or raw BGRA over JSON. The camera host and extension never receive
provider credentials.

This cannot be a silent npm postinstall. An npm CLI can unpack/open the signed and notarized host
app, explain the required approval, verify activation, and report exact next steps.

### Windows camera

Target Windows 11 first with `MFCreateVirtualCamera`. A current-user virtual camera can avoid an
administrator-wide installation, though it still requires a custom Media Foundation source and
correct COM/service visibility. Rust can use Microsoft's `windows-rs` bindings. Do not add a
DirectShow/Windows 10 fallback until there is demonstrated demand.

### Linux camera

Use the established `v4l2loopback` kernel module and write only the userspace frame producer in
Rust. Do not write another kernel module. The npm CLI should detect the module and provide
distro-specific installation/loading guidance. Root access, Secure Boot signing, and DKMS make a
silent self-contained install unrealistic.

### Virtual audio

- macOS: a custom virtual microphone is possible as an Audio Server Driver Plug-in, using Apple's C
  interface with a Rust core. Keep BlackHole initially.
- Windows: a virtual microphone typically requires WDK/SysVAD-style driver work and production
  signing. Keep an existing virtual audio device until demand justifies it.
- Linux: use PipeWire virtual sources/loopback; no custom kernel driver is needed.

### Platform call control

Keep the current thin Swift helper for FaceTime Accessibility, ScreenCaptureKit, AVAudioEngine, and
CoreAudio integration. Rewriting these bindings in Rust does not reduce the platform-specific work.
Rust remains appropriate behind a stable C ABI if shared native logic grows.

## Security, privacy, and licensing

- Bind renderer servers to loopback only.
- Authenticate every browser/event connection with an unguessable per-process token.
- Authenticate OBS WebSocket and reject non-loopback OBS URLs by default.
- Build CSP from required capabilities. Permit `wasm-unsafe-eval` only for a backend that actually
  needs WASM compilation; never add broad `unsafe-eval` as a shortcut.
- Bundle assets locally by default. Remote asset URLs require explicit configuration, transport
  validation, CORS support, and a documented privacy boundary.
- Never connect analysis audio to the physical browser output.
- Never persist PCM, frames, portraits, or embeddings without an explicit diagnostics setting and
  consent.
- Sidecars receive media and avatar controls only, never provider credentials.
- Bound every media queue and validate every frame/message length before allocation.
- Record source URL, author, license, attribution, asset hash, modifications, and redistribution
  decision for every shipped asset.
- Rive Marketplace assets require CC BY attribution. A demo must include that attribution in the
  repository and package notices.
- VRM embedded metadata is advisory; the package's license inventory remains authoritative.
- Portrait/neural renderers require explicit consent and retention/deletion documentation.

## Performance and quality targets

Initial targets on the reference Apple Silicon Mac:

- Default renderer JS/WASM plus default asset: no more than 1 MB Brotli-compressed.
- Default character asset: target below 500 KB.
- Renderer-ready warm start: target below 500 ms after page load, excluding OBS startup.
- Sustained frame rate: 30 fps at 1280x720 without an unbounded queue.
- Mouth/audio skew: median absolute error no greater than 100 ms and p95 no greater than 150 ms.
- Clear-to-neutral mouth: no more than one rendered frame plus IPC scheduling, target below 50 ms.
- Idle motion: neutral pose remains stable; only explicitly authored behaviors such as occasional
  blinking are permitted.
- No visible teeth/geometry corruption at any canonical viseme extreme.
- No audible duplicate/echo path from the renderer.
- Renderer or sink failure never terminates an otherwise healthy audio call.

These are acceptance targets, not claims already proven by the preview.

## Implementation plan

### Phase 0: Preserve and clean the evidence

- [ ] Record the current TalkingHead experiments as evidence rather than production architecture.
- [ ] Keep the 2.7 MB rig-preserving optimizer only if a VRM/TalkingHead fallback still needs it.
- [ ] Remove failed crop/target-pruning approaches and document why validator-clean did not mean
  render-correct.
- [ ] Update `PLAN.md` and `README.md` to point to this document and stop calling TalkingHead the
  chosen long-term backend.
- [ ] Decide whether the uncommitted optimized GLB prototype belongs in history, a fixture release,
  or should be removed when Rive lands.

Exit: the repository truthfully distinguishes experiments, supported behavior, and intended
architecture.

### Phase 1: Prove real OpenClaw media flow

- [ ] Add an output-media callback to the Control UI realtime transport and attach it to the remote
  `MediaStream` in direct WebRTC mode.
- [ ] Drive a procedural/test face from the existing OpenAI Realtime session without creating a
  second provider connection or exposing either OpenAI credential to avatar code.
- [ ] Prove live OpenAI output, response completion, cancellation, and barge-in drive visible mouth
  motion and atomic clear in the Control UI.
- [ ] Add `GatewayAvatarSource` at `RealtimeVoiceAudioSink` and prove the same lifecycle through
  `gateway-relay`.
- [ ] Add a deterministic fake realtime provider that emits known PCM, lifecycle, and clear events
  through the actual Gateway path.
- [ ] Load the FaceTime plugin through OpenClaw Gateway rather than the preview executable and prove
  provider PCM reaches both the native audio bridge and avatar subscriber.
- [ ] Record the smallest public SDK additions required for browser output-track attachment and
  Gateway audio-sink fanout.

Exit: documented tests prove one OpenAI utterance through direct WebRTC and one Gateway-owned
utterance drive the same avatar semantics, with barge-in clearing the actual playback and face
together.

### Phase 2: Extract avatar session core

- [ ] Replace `FaceTimeAvatarRuntime`, `FaceTimeAvatarServer`, and `FaceTimeOutputPacer` avatar
  coupling with renderer-neutral avatar session modules.
- [ ] Implement the `AvatarEvent` schema, runtime validation, generation semantics, and bounded
  fanout.
- [ ] Keep channel audio pacing in the channel, but have it call the shared avatar session.
- [ ] Implement media-clock timestamps and sequence numbers.
- [ ] Implement state, expression, clear, and end lifecycle.
- [ ] Implement `BrowserWebRtcAvatarSource` and `GatewayAvatarSource` behind one internal source
  contract; do not expose provider-specific source configuration.
- [ ] Add a renderer contract-test harness.
- [ ] Do not provide old-name exports or duplicate config aliases.

Exit: a no-op/test renderer passes the complete lifecycle and queue contract without FaceTime or
OBS imports.

### Phase 3: Build the renderer-neutral browser host

- [ ] Serve the browser host through an OpenClaw plugin HTTP route where available; retain a
  loopback standalone server only as a development/OBS adapter.
- [ ] Provide an authenticated event transport and host-owned canvas.
- [ ] Integrate with the existing Control UI realtime session and remote output track rather than
  creating a parallel Talk/provider session.
- [ ] Move HeadAudio into the host as the initial audio fallback.
- [ ] Emit canonical viseme frames from HeadAudio and forward provider-timed visemes when available.
- [ ] Implement capability-based CSP.
- [ ] Implement first-frame readiness and non-background frame validation.
- [ ] Implement renderer unload/reload and transport recovery.
- [ ] Add direct `canvas.captureStream()` output.

Exit: a test renderer and procedural renderer work in preview and direct browser capture without
OBS.

### Phase 4: Implement `@openclaw/avatar-rive`

- [ ] Add `@rive-app/canvas-lite` and remove Three/TalkingHead from the default dependency path.
- [ ] Implement current Rive data-binding controls for canonical visemes, conversational state,
  expression, eye direction, and blink.
- [ ] Build a temporary adapter for the Bob marketplace asset and record CC BY attribution.
- [ ] Map all canonical visemes and verify each produces a distinguishable expected mouth pose.
- [ ] Ensure neutral, listening, thinking, speaking, and error states are visually authored.
- [ ] Disable perpetual idle wandering; permit only intentional blink/breathing behavior.
- [ ] Add asset validation that reports missing bindings by name before declaring ready.
- [ ] Demo the Rive backend through preview, OBS, and Photo Booth with the same audible PCM fixture.

Exit: the Rive demo is visibly preferable to MPFB, stays synchronized, clears correctly, and keeps
the default delivered renderer below the size budget.

### Phase 5: Create the OpenClaw default character

- [ ] Define an art brief: friendly, neutral-gender or selectable presentation, readable at small
  sizes, expressive without distraction, and clearly not a human impersonation.
- [ ] Create or commission original source artwork and retain editable source files.
- [ ] Author the full canonical viseme set, blink, gaze, and core conversational expressions.
- [ ] Include alternate color/hair/accessory configurations only if they do not complicate the core
  runtime.
- [ ] License the asset permissively and record provenance/hash.
- [ ] Run accessibility and cultural review of the default presentation.

Exit: OpenClaw ships an original default asset with no external attribution dependency.

### Phase 6: Separate video sinks

- [ ] Extract OBS control from the renderer runtime into an OBS sink.
- [ ] Implement preview/canvas sink.
- [ ] Implement WebRTC/browser sink using `captureStream()` or a generated track.
- [ ] Specify a loopback browser-to-native video bridge for direct-WebRTC sessions before claiming
  that a browser renderer can feed the native-camera sink.
- [ ] Keep sink failure isolated from renderer and audio sessions.
- [ ] Reconcile OBS scene/source/Virtual Camera state after OBS or Gateway restarts.
- [ ] Add exact degraded status without mutating unrelated operator scenes.

Exit: the same Rive renderer can switch among preview, WebRTC, and OBS through configuration only.

### Phase 7: Implement optional VRM backend

- [ ] Add `@pixiv/three-vrm` in a separate renderer package.
- [ ] Load VRM 1.0 and an explicitly selected VRM 0.x compatibility path only if needed by chosen
  assets; do not add aliases to the core contract.
- [ ] Map canonical visemes into VRM expressions.
- [ ] Disable uncontrolled spring-bone/head motion by default.
- [ ] Select and audit one CC0 stylized avatar from the open registry.
- [ ] Optimize textures/geometry without flattening required VRM metadata or rig nodes.
- [ ] Publish backend-specific size, memory, and frame-time results.

Exit: VRM is a supported optional 3D backend and does not affect default Rive installation cost.

### Phase 8: Native sidecar protocol

- [ ] Define the binary framing and handshake for native renderer and sink processes.
- [ ] Reuse or generalize the existing five-byte control/audio framing only if the resulting protocol
  remains clear; do not retain FaceTime-specific message names.
- [ ] Add version negotiation, message caps, crash handling, and stderr diagnostics.
- [ ] Implement a shared-memory frame ring with explicit pixel format, dimensions, generation, PTS,
  and ownership.
- [ ] Build a Rust reference sidecar that renders a deterministic test pattern and accepts all
  lifecycle events.
- [ ] Add npm platform packages containing prebuilt binaries.

Exit: Node can launch a native renderer/sink, drive it with the same events, receive frames, and
recover from crashes without restarting OpenClaw.

### Phase 9: Native virtual cameras

- [ ] Windows 11: Rust/media-source prototype using `windows-rs` and `MFCreateVirtualCamera`.
- [ ] macOS: signed/notarized host app plus CoreMediaIO Camera Extension, with a thin Swift shim and
  Rust shared-memory core.
- [ ] macOS: prove one explicit frame-producer path—prefer Gateway media into a native renderer
  first; treat browser `captureStream()` bridging as a separate supported path.
- [ ] Linux: Rust userspace writer targeting an existing `v4l2loopback` device.
- [ ] Build explicit install/status/uninstall commands; never run privileged silent postinstalls.
- [ ] Add platform approval/signing documentation and actionable diagnostics.

Exit: each supported desktop platform can publish the same renderer without OBS, subject to its
documented system approval requirements.

### Phase 10: Optional Inochi2D and neural backends

- [ ] Spike Inochi2D through its C FFI as a sidecar and measure package/runtime/model costs.
- [ ] Decide whether a Rust wrapper adds real value over a thin C/D process host.
- [ ] Run MuseTalk and Ditto remote-sidecar benchmarks only after the common protocol is stable.
- [ ] Audit every code, checkpoint, detector, and asset license.
- [ ] Require explicit portrait consent, encrypted transport, and retention controls for remote
  portrait rendering.

Exit: add a backend only if it meets the same contract, security, latency, and test requirements as
Rive and VRM.

## Test specification

### Core unit tests

- Event schema accepts valid lifecycle/media events and rejects NaN, infinity, invalid viseme names,
  invalid formats, oversized PCM, and timestamps outside policy.
- Generation increment invalidates every older queued event.
- Sequence gaps reset interpolation without replaying stale values.
- Control messages survive media backpressure.
- Audio and viseme queues remain bounded under slow and disconnected renderers.
- `clear` cancels delayed audio, resets inference, clears mouth weights, and cannot be overtaken by
  older media.
- Renderer failure leaves the audio sink healthy.
- Multiple subscribers cannot backpressure one another or the provider.

### Renderer contract suite

Every backend must pass the same suite:

- Start and stop are idempotent.
- Invalid/missing asset fails with an actionable error.
- Ready is false until a validated first frame is presented.
- Neutral frame is visibly non-background.
- Each canonical viseme fixture reaches the expected renderer control.
- `sil` and `clear` close/reset the mouth within one frame.
- State and expression transitions remain bounded and deterministic.
- Renderer ignores stale generations.
- Disconnect/reconnect does not replay stale audio or frames.
- A renderer crash or thrown exception produces degraded status and clean teardown.

### Visual tests

- Golden frames for neutral, all canonical visemes, blink, listening, thinking, speaking, error, and
  clear.
- Perceptual thresholds tolerate GPU/raster differences but reject blank output, missing face,
  broken alpha, wrong framing, texture loss, or extreme geometry.
- Assert no teeth or mouth layer appears outside the authored mouth mask.
- Assert idle samples over a fixed interval stay within the allowed motion envelope.
- Capture the actual OBS source rather than trusting renderer status.

### Lip-sync and timing tests

- Known phoneme audio fixtures validate the expected sequence of canonical visemes.
- Provider-timed viseme fixtures bypass inference and retain their timestamps.
- Compare rendered mouth transitions with the audible waveform and calculate median/p95 skew.
- Test silence, low-volume speech, plosives, fricatives, long vowels, rapid speech, and non-English
  samples.
- Test a clear in the middle of every scheduled chunk size.
- Test jitter, delayed packets, dropped chunks, and clock drift.

### Browser tests

- Chromium/OBS CEF and Safari-compatible browser targets load every bundled asset locally.
- CSP denies remote scripts and broad eval while allowing only the backend's required WASM behavior.
- AudioContext suspended/resume behavior is actionable.
- WebGL/WebGPU context loss affects only backends that use it and recovers or degrades cleanly.
- `captureStream()` produces the configured resolution and frame rate.
- No renderer audio reaches a physical output device.

### OBS tests

- Missing OBS.
- Wrong password.
- Non-loopback URL rejection.
- Scene/source name collision.
- Existing unrelated scene preservation.
- Browser-source refresh after server restart.
- Virtual Camera unavailable or awaiting system approval.
- OBS crash and restart.
- Gateway restart with stale OBS source/camera state.
- Start/stop ownership: never stop a camera OpenClaw did not start.

### OpenClaw integration tests

- Plugin loads from a clean packed archive.
- Direct OpenAI WebRTC output track drives the avatar without a second provider session or avatar
  access to provider credentials.
- Gateway-relay PCM drives the same avatar contract through `RealtimeVoiceAudioSink` fanout.
- Fake provider PCM drives the renderer through the real plugin session.
- Real agent/provider response drives visible mouth motion.
- Consult/tool calls do not deadlock media.
- Live barge-in clears caller audio and avatar together.
- Local and remote hangup clean all renderer/sink state.
- Concurrent call rejection never creates another avatar session.
- Account isolation prevents cross-call media.
- Gateway restart does not leave a stale virtual camera or media process.

### Platform/native tests

- Sidecar handshake/version mismatch.
- Frame shared-memory bounds and ownership.
- Sidecar crash, hang, malformed message, and restart budget.
- Windows current-user camera registration/start/stop/uninstall.
- macOS extension missing/awaiting approval/activated/update/uninstall.
- Linux missing `v4l2loopback`, permission denial, Secure Boot guidance, device contention, and writer
  teardown.
- Signed release artifacts are reproducible and package selection chooses the correct OS/CPU.

### Performance and soak tests

- Cold/warm renderer load time.
- Asset download/decode time.
- CPU, GPU, memory, frame time, queue depth, and dropped frames.
- 60-minute continuous speaking/listening soak.
- Repeated 100-session start/clear/stop lifecycle soak.
- OBS and direct WebRTC comparisons.
- Native shared-memory throughput without raw-frame stdio fallback.

### Security, privacy, and package tests

- Loopback token rejection and constant-time comparison where secrets are compared.
- Message and allocation caps.
- CSP regression checks.
- Secret scan and no credentials in logs/status.
- No media files created during normal operation.
- Package contains every required runtime, WASM, model, attribution, and native binary.
- Production dependency and asset-license inventory.
- Clean npm install/load/doctor/uninstall on every supported platform.

## Release gates

The first Rive-backed release is ready only when:

- A real OpenClaw-generated utterance drives the renderer through the installed plugin.
- The Rive default passes all renderer contract and golden-frame tests.
- Visible output is verified from the actual selected sink.
- Barge-in clears audio and mouth motion within the target.
- A/V skew meets the published target.
- Preview and OBS sinks pass restart/failure tests.
- Audio-only fallback passes for renderer, browser, asset, OBS, and virtual-camera failures.
- A 60-minute soak has no unbounded memory, queue growth, or stale playback.
- All shipped code and assets have recorded licenses and required attribution.
- The packed archive passes clean installation and OpenClaw plugin diagnostics.

Native-camera packages have separate platform release gates and must not block the browser/OBS
release.

## Reference sources

- [HeadAudio](https://github.com/met4citizen/HeadAudio)
- [TalkingHead](https://github.com/met4citizen/TalkingHead)
- [Rive WASM/JS runtime](https://github.com/rive-app/rive-wasm)
- [Rive web runtime size comparison](https://rive.app/docs/runtimes/runtime-sizes)
- [Rive Canvas versus WebGL2](https://rive.app/docs/runtimes/web/canvas-vs-webgl)
- [Rive Marketplace licensing](https://rive.app/docs/community/marketplace-overview)
- [VRM Consortium](https://vrm-consortium.org/en/)
- [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm)
- [Open Source Avatars registry](https://github.com/toxsam/open-source-avatars)
- [Inochi2D](https://github.com/Inochi2D/inochi2d)
- [OBS Studio](https://github.com/obsproject/obs-studio)
- [Canvas capture stream specification](https://www.w3.org/TR/mediacapture-fromelement/)
- [Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)
- [Apple CoreMediaIO Camera Extension](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o)
- [Microsoft `MFCreateVirtualCamera`](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera)
- [Microsoft `windows-rs`](https://github.com/microsoft/windows-rs)
- [`v4l2loopback`](https://github.com/v4l2loopback/v4l2loopback)
- [Apple Audio Server Driver Plug-in sample](https://developer.apple.com/documentation/coreaudio/creating-an-audio-server-driver-plug-in)
- [Microsoft SysVAD sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/)
- [PipeWire loopback/virtual source](https://docs.pipewire.org/devel/page_module_loopback.html)
- [`wgpu`](https://github.com/gfx-rs/wgpu)
