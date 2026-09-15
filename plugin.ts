import { createLobsterLiveVisualProvider, type LiveVisualProvider } from "./src/provider.js";

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  registerLiveVisualProvider(provider: LiveVisualProvider): void;
};

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

export default {
  id: "openclaw-avatar",
  name: "OpenClaw Avatar",
  description: "Provides the PCM-driven OpenClaw lobster as a live visual surface.",
  register(api: PluginApi) {
    const config = api.pluginConfig ?? {};
    const port = positiveInteger(config.port);
    const maxBufferedBytes = positiveInteger(config.maxBufferedBytes);
    api.registerLiveVisualProvider(
      createLobsterLiveVisualProvider({
        ...(port ? { port } : {}),
        ...(maxBufferedBytes
          ? {
              maxSubscriberMediaBytes: maxBufferedBytes,
              maxTransportBufferedBytes: maxBufferedBytes,
            }
          : {}),
      }),
    );
  },
};
