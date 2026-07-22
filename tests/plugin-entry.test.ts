import { describe, expect, it, vi } from "vitest";
import avatarPlugin from "../index.js";

describe("OpenClaw plugin entry", () => {
  it("registers the supported route, service, and external Control UI tab surfaces", async () => {
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown }).openclawAvatarPluginState;
    const routes: any[] = [];
    const services: any[] = [];
    const descriptors: any[] = [];
    let onActivity: ((event: any) => void) | undefined;
    const detachActivity = vi.fn();
    const watchActivity = vi.fn((listener: (event: any) => void) => {
      onActivity = listener;
      return detachActivity;
    });
    const api = {
      pluginConfig: {},
      runtime: { talk: { watchActivity, openSession: vi.fn() } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerHttpRoute: (route: unknown) => routes.push(route),
      registerService: (service: unknown) => services.push(service),
      session: {
        controls: {
          registerControlUiDescriptor: (descriptor: unknown) => descriptors.push(descriptor),
        },
      },
    };
    avatarPlugin.register?.(api as never);
    avatarPlugin.register?.(api as never);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      path: "/plugins/avatar",
      auth: "gateway",
      match: "prefix",
    });
    expect(services).toHaveLength(2);
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]).toMatchObject({
      surface: "tab",
      id: "avatar",
      path: expect.stringContaining("token="),
      requiredScopes: ["operator.read", "operator.write", "operator.talk.secrets"],
    });
    expect(descriptors[1].path).toBe(descriptors[0].path);
    await services[0].start();
    await services[1].start();
    expect(watchActivity).toHaveBeenCalledOnce();
    onActivity?.({
      type: "started",
      activityId: "live",
      timestamp: "2026-07-22T00:00:00Z",
    });
    onActivity?.({
      type: "speech",
      activityId: "live",
      timestamp: "2026-07-22T00:00:00.020Z",
    });
    const rendererUrl = new URL(descriptors[1].path, "http://127.0.0.1");
    rendererUrl.pathname = "/plugins/avatar/health";
    let body = "";
    await routes[0].handler(
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
    expect(JSON.parse(body).session).toMatchObject({
      active: true,
      visemeFrames: 1,
    });
    await services[0].stop();
    expect(detachActivity).not.toHaveBeenCalled();
    await services[1].stop();
    expect(detachActivity).toHaveBeenCalledOnce();
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown }).openclawAvatarPluginState;
  });

  it("routes browser microphone audio through one owned Talk session", async () => {
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown }).openclawAvatarPluginState;
    const routes: any[] = [];
    let onEvent: ((event: any) => void) | undefined;
    const handle = {
      sendAudio: vi.fn(),
      cancelOutput: vi.fn(),
      close: vi.fn(),
    };
    const openSession = vi.fn(async (params: { onEvent: (event: any) => void }) => {
      onEvent = params.onEvent;
      return handle;
    });
    const api = {
      pluginConfig: { sessionKey: "agent:main:avatar" },
      runtime: {
        talk: { watchActivity: vi.fn(() => () => {}), openSession },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerHttpRoute: (route: unknown) => routes.push(route),
      registerService: vi.fn(),
      session: { controls: { registerControlUiDescriptor: vi.fn() } },
    };
    avatarPlugin.register?.(api as never);

    const descriptorCalls = (api.session.controls.registerControlUiDescriptor as ReturnType<typeof vi.fn>).mock.calls;
    const descriptor = descriptorCalls[0]?.[0] as { path: string } | undefined;
    expect(descriptor).toBeDefined();
    const token = new URL(descriptor!.path, "http://local").searchParams.get("token");
    const invokeWithToken = async (suffix: string, body: Record<string, unknown>) => {
      const requestBody = Buffer.from(JSON.stringify(body));
      let responseBody = "";
      const response = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: (value = "") => (responseBody = value),
      };
      await routes[0].handler(
        {
          method: "POST",
          url: `/plugins/avatar/talk/${suffix}?token=${token}`,
          socket: { remoteAddress: "127.0.0.1", localPort: 9999 },
          async *[Symbol.asyncIterator]() {
            yield requestBody;
          },
        },
        response,
      );
      return { status: response.statusCode, body: JSON.parse(responseBody) };
    };

    const started = await invokeWithToken("start", {});
    expect(started.status).toBe(200);
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "agent:main:avatar" }));
    onEvent?.({ type: "state", generation: 1, ptsMs: 0, state: "listening" });
    onEvent?.({
      type: "audio",
      generation: 1,
      sequence: 0,
      ptsMs: 0,
      pcm: new Uint8Array([1, 0]),
    });
    await invokeWithToken("audio", {
      sessionId: started.body.sessionId,
      audioBase64: "AgA=",
      timestamp: 20,
    });
    await invokeWithToken("cancel-output", {
      sessionId: started.body.sessionId,
    });
    await invokeWithToken("stop", { sessionId: started.body.sessionId });

    expect(handle.sendAudio).toHaveBeenCalledWith(Buffer.from([2, 0]), {
      timestamp: 20,
    });
    expect(handle.cancelOutput).toHaveBeenCalledWith("barge-in");
    expect(handle.close).toHaveBeenCalledOnce();
    delete (globalThis as typeof globalThis & { openclawAvatarPluginState?: unknown }).openclawAvatarPluginState;
  });
});
