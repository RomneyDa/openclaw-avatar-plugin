# Browser evidence

`avatar-demo.png` is captured by `npm run test:browser` from a real headless Google Chrome frame at
1280×720 after synthetic PCM16LE 24 kHz mono audio reaches the browser renderer. The smoke also
samples canvas pixels, asserts the speaking state, checks non-background foreground population,
and verifies the host accepted first-frame readiness.

This is generated visual-test evidence, not a runtime character asset.

On a successful `npm run demo:live`, the command produces `live-speaking.png`, `live-neutral.png`,
and `live-proof.json`. The JSON contains only counters, generations, rolling byte digests, renderer
state, and commit metadata; it does not contain PCM, transcripts, provider credentials, or renderer
tokens.

Those three live artifacts are intentionally absent from this commit. The 2026-07-17 run reached
OpenAI through a real Gateway-owned `talk.session.create`, but the configured API-key account
returned `quota_exceeded` before readiness and emitted no assistant audio. After quota is restored,
rerun from the plugin checkout:

```bash
OPENCLAW_CORE_PATH=/path/to/openclaw npm run demo:live
```
