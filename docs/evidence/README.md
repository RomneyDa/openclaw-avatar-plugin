# Browser evidence

`avatar-demo.png` is captured by `npm run test:browser` from a real headless Google Chrome frame at
1280×720 after synthetic PCM16LE 24 kHz mono audio reaches the browser renderer. The smoke also
samples canvas pixels, asserts the speaking state, checks non-background foreground population,
and verifies the host accepted first-frame readiness.

This is generated visual-test evidence, not a runtime character asset.

The checked-in `live-speaking.png`, `live-neutral.png`, and `live-proof.json` were produced by the
2026-07-18 `npm run demo:live` run using `gpt-realtime-2.1` through a real Gateway-owned Talk
session. The JSON proves an exact 153,600-byte PCM prefix by byte count and rolling digest, then
records cancel/clear neutrality and provider continuation with the renderer absent. It contains
only counters, generations, rolling byte digests, renderer state, and commit metadata; it does not
contain PCM, transcripts, provider credentials, or renderer tokens.

To regenerate from the plugin checkout:

```bash
OPENCLAW_CORE_PATH=/path/to/openclaw npm run demo:live
```
