export { createAvatarRenderer, type AvatarRenderer, type AvatarRendererOptions } from "./src/renderer.js";
export { createAvatarMediaConsumer, type AvatarMediaConsumer } from "./src/adapter.js";
export { AvatarBrowserHost, type AvatarBrowserHostOptions } from "./src/browser-host.js";
export {
  AVATAR_AUDIO_FORMAT,
  CANONICAL_VISEMES,
  validateAvatarEvent,
  type AvatarClearReason,
  type AvatarEvent,
  type AvatarSessionDescription,
  type AvatarState,
  type CanonicalViseme,
} from "./src/events.js";
export { AvatarSession, type AvatarSessionMetrics, type AvatarSessionOptions } from "./src/session.js";
