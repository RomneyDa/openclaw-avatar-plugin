# OpenClaw Avatar Plugin

An external [OpenClaw](https://github.com/openclaw/openclaw) plugin that turns the exact outgoing
audio from an existing voice session into a polished, local animated avatar. The MVP ships an
original code-native 2D canvas character (“Clawbit”), an authenticated browser host, a canonical
renderer event contract, and bounded session fanout.

![Clawbit speaking in the browser smoke test](docs/evidence/avatar-demo.png)

The plugin never opens a model/provider session, accepts provider credentials, plays a second copy
of the audio, or records media. On an OpenClaw build with the generic Talk output-media tap it
observes the already-owned PCM stream. On stock builds without that tap, the UI and synthetic demo
still work and the plugin reports the missing attachment without affecting audio.

## Quick demo

Requirements: Node 22.22.3 or newer and a local Chromium-based browser.

```bash
npm install
npm run demo
```

The command prints an unguessable loopback URL. Open it in a browser. To open it automatically on
macOS:

```bash
npm run demo -- --open
```

The demo cycles through listening, thinking, and speaking with generated PCM16LE 24 kHz mono audio,
then issues an atomic clear so the mouth returns to neutral immediately.

## Install in OpenClaw

Build and verify the same tarball shape users receive:

```bash
npm install
npm run test:package
npm pack
openclaw plugins install npm-pack:"$PWD/openclaw-avatar-plugin-0.1.0.tgz" --force
openclaw plugins inspect avatar --runtime --json
```

Then enable the plugin and restart the Gateway if the installer does not do so automatically:

```bash
openclaw plugins enable avatar
openclaw gateway restart
```

Open **Avatar** in the Control UI sidebar. The tab is an external-plugin iframe served by the
plugin’s supported `registerHttpRoute` surface. The host rejects non-loopback clients, so a Control
UI opened from another machine intentionally receives `403`; use the UI on the Gateway host or the
standalone demo there.

## Configuration

Configuration belongs under `plugins.entries.avatar.config`:

```json
{
  "plugins": {
    "entries": {
      "avatar": {
        "enabled": true,
        "config": {
          "enabled": true,
          "standalonePort": 0,
          "maxAudioChunkBytes": 96000,
          "maxSubscriberMediaBytes": 1048576,
          "video": {
            "width": 1280,
            "height": 720,
            "frameRate": 30
          }
        }
      }
    }
  }
}
```

`standalonePort: 0` (default) disables the additional development server. A nonzero value starts
the same authenticated host on `127.0.0.1`; the Gateway route remains the preferred installed
surface. The renderer URL contains a fresh 192-bit process token and must be treated like a local
session URL.

## Media and renderer contract

The canonical `AvatarEvent` union is exported from the package. Its media format is fixed:

- signed PCM16 little-endian;
- 24,000 Hz;
- mono;
- timestamps in milliseconds from the current output generation’s media clock.

Events cover `session.start`, `audio`, canonical visemes, conversational state, expression,
`clear`, and `session.end`. The canonical visemes are:

```text
sil PP FF TH DD kk CH SS nn RR aa E I O U
```

Every subscriber has independent bounded media queues. Slow or failing subscribers cannot block
the media owner or a sibling renderer. On overflow, media is dropped and counted; control messages
make room by evicting stale media, and a subscriber stalled on control-only traffic is explicitly
detached rather than growing an unbounded queue. A clear advances the generation, removes queued
older media, and the browser resets audio level, visemes, expressions, and its visible mouth in the
same task/frame.

The browser transport JSON-encodes control events and exact PCM bytes as base64. That encoding is
local transport only; the core TypeScript contract continues to use `Uint8Array`. The code-native
renderer is behind the event boundary, so a future Rive renderer can consume the same stream without
changing the OpenClaw adapter or session core.

## Exact OpenClaw adapter needed from core

The plugin feature-detects this runtime shape and otherwise stays in local-idle mode:

```ts
api.runtime.talk.subscribeOutputMedia({
  sessionId?: string,
  sessionKey?: string,
  onEvent(event): void | Promise<void>
}): () => void
```

The source events are provider-neutral:

- `session.start`: `sessionId`, optional `sessionKey`, `generation`, and exact audio format;
- `state`: the same identity/generation plus `ptsMs` and the canonical conversational state;
- `audio`: the same identity/generation plus monotonic `sequence`, `ptsMs`, and `Uint8Array pcm`;
- `clear`: the new generation and canonical clear reason;
- `session.end`: the final generation and reason.

`attachOpenClawOutputMedia` supplies configured video dimensions on start and otherwise maps core
generation, sequence, timestamp, state, PCM, clear, and end values without reinterpretation. It
selects one active session for the one-avatar MVP. The core media owner must remain responsible for
provider/session creation, audio playback, resampling into the canonical format, and synchronized
clear. The avatar receives no provider object, auth profile, API key, client secret, or generic raw
Talk broadcast.

This is intentionally one narrow adapter boundary. `AvatarMediaSourceAdapter` and
`AvatarMediaConsumer` are also exported for deterministic tests and future browser-owned WebRTC
attachment, where decoded remote-track audio must be resampled once at the browser media owner.

## Current OpenClaw plugin-surface preflight

The implementation was checked against OpenClaw `origin/main` at
`dc0285366efcfd3130f75349af030fdde3a86dcb` (2026-07-17):

- `api.registerHttpRoute` supports a prefix handler and WebSocket `handleUpgrade` on the Gateway;
- `api.registerService` owns startup/teardown;
- `api.session.controls.registerControlUiDescriptor({ surface: "tab", path })` gives an external
  plugin a sandboxed Control UI frame;
- external plugins cannot ship a native bundled Control UI view, so the supported iframe route is
  the correct surface;
- the plugin imports only `openclaw/plugin-sdk/plugin-entry` and does not reach into core internals.

The route declares plugin-managed authentication because its random token and loopback check are
the complete renderer security boundary. It does not assume Gateway operator scopes or dispatch
privileged Gateway helpers from the frame.

## Existing-solutions preflight

Maintained projects cover important later renderer pieces but not this MVP’s full OpenClaw media
ownership and security contract:

- [Rive’s MIT web runtime](https://github.com/rive-app/rive-wasm) is the leading future authored
  2D backend, with state machines/data binding and a low-level canvas loop. It still needs an
  original `.riv` character and the local OpenClaw adapter/session/host built here.
- [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) is the appropriate optional standardized
  3D backend, but retains Three.js/WebGL and model assets.
- [TalkingHead](https://github.com/met4citizen/TalkingHead) and HeadAudio prove browser PCM-driven
  visemes, but their 3D/model-specific architecture and dependency weight are not the renderer-
  neutral default required here.
- OpenClaw’s existing Canvas plugin demonstrates the supported route/service/WebSocket shape, but
  it is a general paired-node/A2UI surface rather than an exact voice-output avatar pipeline.

The MVP therefore uses a small original Canvas2D renderer with no likeness/model asset or
proprietary runtime while retaining clean renderer and future sink boundaries.

## Renderer behavior and readiness

Clawbit has authored idle, listening, thinking, speaking, and error treatments, bounded floating
motion, intermittent blinking, orbit/status signals, canonical-viseme shaping, and PCM RMS-driven
mouth motion. No analysis graph is connected to browser output.

“Ready” requires more than a WebSocket connection. After drawing, the browser samples the actual
canvas, requires a threshold of foreground pixels, then reports the validated first frame. The
browser smoke launches real Chrome, streams synthetic canonical PCM, captures a 1280×720 speaking
frame, checks the visible status and foreground population, and verifies the host accepted first-
frame readiness:

```bash
npm run test:browser
```

## Metrics and privacy

`AvatarSession.snapshot()` and `AvatarBrowserHost.snapshot()` expose only bounded counters and
status: generation/state, subscriber and queue depth, input/sent/dropped byte counts, viseme/control/
rendered frame counts, first-frame validation, readiness, and a bounded last renderer error.

Normal operation never writes PCM, frames, portraits, transcripts, credentials, or provider data.
The checked-in screenshot is produced only by the explicit browser-smoke command. Logs contain no
media and do not include the renderer token/URL. Browser assets are local, CSP blocks remote assets,
media, objects, forms, broad eval, and inline script/style. Every HTTP and WebSocket request requires
the per-process token and a loopback peer address.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:package
git diff --check
```

The focused suite covers schema rejection, exact PCM constraints, external generation/sequence
mapping, stale-generation removal, bounded slow-subscriber behavior, failure isolation, token
rejection, CSP, transport fidelity, readiness, and a real rendered frame.

## License and attribution

Code and original Clawbit artwork are MIT licensed. No third-party likeness, marketplace character,
Rive file, GLB/VRM, neural model, or proprietary runtime ships in the package. See [NOTICE.md](NOTICE.md).
