# OpenClaw Avatar Renderer

A small reusable lobster renderer for caller-owned voice integrations. It exposes an authenticated
loopback browser surface and a canonical PCM/viseme event consumer. It does not create, observe, or
coordinate voice sessions.

```ts
import { createAvatarRenderer } from "openclaw-avatar-plugin/renderer";

const renderer = createAvatarRenderer({ port: 0 });
await renderer.start();

renderer.consumer.start({
  sessionId: "opaque-session-id",
  video: { width: 1280, height: 720, frameRate: 30 },
  initialState: "listening",
});

// PTS is derived by the media owner from emitted PCM sample counts.
renderer.consumer.audio(providerPcm16le24kMono, emittedSamples / 24);
console.log(renderer.rendererUrl);
```

## Ownership boundary

This package owns only:

- the code-native Canvas2D lobster and local browser assets;
- the canonical media/control contract;
- the token-authenticated loopback HTTP/WebSocket host;
- bounded renderer queues, generations, stale-media rejection, readiness, and metrics.

The embedding integration owns its provider session, credentials, tools, call IDs, media pacer,
audio playback, OBS/Virtual Camera lifecycle, interruption, cancellation, and cleanup. The renderer
has no OpenClaw runtime, microphone, Talk, FaceTime, OBS, or provider dependency.

## Contract

Audio is exact signed PCM16LE, 24 kHz, mono. `ptsMs` is presentation time within the active output
generation. Control events cover `session.start`, state, expression, `clear`, and `session.end`;
media events cover PCM and optional canonical visemes.

Each subscriber has bounded queues. A clear advances the session generation and removes queued
older media before publishing the clear. Slow or failing subscribers cannot block the media owner
or healthy siblings. HTTP and WebSocket access require both loopback origin and a fresh process
token. Browser assets use a strict CSP and no remote dependencies.

## Development

```bash
npm ci
npm run check
```

`npm run demo` starts a synthetic sample-clock-driven preview. `npm run test:browser` verifies the
real browser first frame and PCM-driven mouth motion. `npm run test:package` proves a clean packed
install can import `openclaw-avatar-plugin/renderer` without installing OpenClaw or FaceTime code.

The package has not been published to npm and has no shipped compatibility obligation as an
OpenClaw plugin. The former standalone Talk product and plugin manifest were intentionally removed
when this repository became a renderer library.
