import { describe, expect, it, vi } from "vitest";
import avatarPlugin from "../index.js";

describe("OpenClaw plugin entry", () => {
  it("registers the supported route, service, and external Control UI tab surfaces", async () => {
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown })
      .openclawAvatarPluginState;
    const routes: any[] = [];
    const services: any[] = [];
    const descriptors: any[] = [];
    let onMediaEvent: ((event: any) => void) | undefined;
    const detachMedia = vi.fn();
    const subscribeOutputMedia = vi.fn((params: { onEvent: (event: any) => void }) => {
      onMediaEvent = params.onEvent;
      return detachMedia;
    });
    const api = {
      pluginConfig: {},
      runtime: { talk: { subscribeOutputMedia } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerHttpRoute: (route: unknown) => routes.push(route),
      registerService: (service: unknown) => services.push(service),
      session: { controls: { registerControlUiDescriptor: (descriptor: unknown) => descriptors.push(descriptor) } },
    };
    avatarPlugin.register?.(api as never);
    avatarPlugin.register?.(api as never);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ path: "/plugins/avatar", auth: "plugin", match: "prefix" });
    expect(services).toHaveLength(2);
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toMatchObject({ surface: "tab", id: "avatar", path: expect.stringContaining("token=") });
    expect(descriptors[1].path).toBe(descriptors[0].path);
    await services[0].start();
    await services[1].start();
    expect(subscribeOutputMedia).toHaveBeenCalledOnce();
    onMediaEvent?.({
      type: "session.start",
      sessionId: "live",
      generation: 1,
      audio: { encoding: "pcm16le", sampleRateHz: 24_000, channels: 1 },
    });
    onMediaEvent?.({
      type: "audio",
      sessionId: "live",
      generation: 1,
      sequence: 0,
      ptsMs: 0,
      pcm: new Uint8Array([0, 1, 2, 3]),
    });
    const rendererUrl = new URL(descriptors[1].path, "http://127.0.0.1");
    rendererUrl.pathname = "/plugins/avatar/health";
    let body = "";
    await routes[1].handler(
      {
        method: "GET",
        url: `${rendererUrl.pathname}${rendererUrl.search}`,
        socket: { remoteAddress: "127.0.0.1" },
      },
      {
        setHeader: vi.fn(),
        end: (value: string) => {
          body = value;
        },
      },
    );
    expect(JSON.parse(body).session).toMatchObject({ active: true, inputAudioBytes: 4 });
    await services[0].stop();
    expect(detachMedia).not.toHaveBeenCalled();
    await services[1].stop();
    expect(detachMedia).toHaveBeenCalledOnce();
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown })
      .openclawAvatarPluginState;
  });
});
