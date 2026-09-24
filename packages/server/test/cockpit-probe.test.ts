import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProviderKey, syncProjectKeyFleet } from "../src/cockpit/ws.js";
import { KeyFleetMonitor } from "@prismshadow/penguin-core";
import { ProjectConfigService } from "../src/services/project-config-service.js";

afterEach(() => vi.restoreAllMocks());

describe("cockpit credential destination", () => {
  it("never sends an unknown provider's credential to OpenAI", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const result = await probeProviderKey("private-gateway", "test-only-credential");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("configured");
  });

  it("uses the configured gateway base URL and forbids credential-bearing redirects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const result = await probeProviderKey("anthropic", "test-only-credential", {
      baseUrl: "https://gateway.example.test/proxy/v1/",
      clientType: "ant-messages",
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gateway.example.test/proxy/v1/models",
      expect.objectContaining({
        headers: { "x-api-key": "test-only-credential", "anthropic-version": "2023-06-01" },
        redirect: "error",
      }),
    );
  });

  it("cancels a live provider request when the fleet deadline aborts", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort();
      sawAbort = init?.signal?.aborted === true;
      throw new Error("aborted");
    });
    const probing = probeProviderKey("openai", "test-only-credential", {
      signal: controller.signal,
    });
    const result = await probing;
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sawAbort).toBe(true);
    expect(result).toMatchObject({ ok: false, error: "Probe cancelled" });
  });

  it("inherits the configured group gateway when synchronizing the project's keys", async () => {
    const service = new ProjectConfigService("unused-test-root");
    vi.spyOn(service, "readRaw").mockResolvedValue({
      group_defaults: { custom: { default_base_url: "https://gateway.example.test/v1" } },
      models: [
        {
          provider: "custom",
          model_id: "unit",
          client_type: "openai-chat",
          api_key: "test-key-only",
        },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const monitor = new KeyFleetMonitor();
    try {
      await syncProjectKeyFleet({ projectConfigService: service }, "group-probe-test", monitor);
      const result = await monitor.probeKey("custom", "custom-key-1");
      expect(result.status).toBe("ok");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://gateway.example.test/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-key-only" },
          redirect: "error",
        }),
      );
    } finally {
      monitor.clear();
    }
  });

  it("keeps Google credentials out of URLs and errors", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network failed with test-only-credential"));
    const result = await probeProviderKey("google", "test-only-credential");
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("test-only-credential");
    expect(result.error).not.toContain("test-only-credential");
  });
});
