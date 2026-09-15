import { type LiveVisualProvider } from "./src/provider.js";
type PluginApi = {
    pluginConfig?: Record<string, unknown>;
    registerLiveVisualProvider(provider: LiveVisualProvider): void;
};
declare const _default: {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
};
export default _default;
