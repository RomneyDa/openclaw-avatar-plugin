import { describe, expect, it, vi } from "vitest";
import avatarPlugin from "../index.js";

describe("OpenClaw plugin entry", () => {
  it("registers the supported route, service, and external Control UI tab surfaces", async () => {
    const routes: any[] = [];
    const services: any[] = [];
    const descriptors: any[] = [];
    const api = {
      pluginConfig: {},
      runtime: {},
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
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("media tap unavailable"));
    await services[0].stop();
  });
});
