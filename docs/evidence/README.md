# Browser evidence

`avatar-demo.png` is captured by `npm run test:browser` from a real headless Google Chrome frame at
1280×720 after synthetic PCM16LE 24 kHz mono audio reaches the browser renderer. The smoke also
samples canvas pixels, asserts the speaking state, checks non-background foreground population,
and verifies the host accepted first-frame readiness.

This is generated visual-test evidence, not a runtime character asset.
