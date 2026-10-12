import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { aiGatewayRequest } from "../aiGatewayInternal.utils";

const fetchMock: jest.Mock<(...args: any[]) => Promise<any>> = jest.fn();

describe("aiGatewayRequest", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("sends the internal key and the caller's org and role headers", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ settings: {} }) });

    const result = await aiGatewayRequest("GET", "/internal/guardrails/settings", {
      organizationId: 7,
      role: "Admin",
    });

    expect(result).toEqual({ settings: {} });
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(String(url)).toMatch(/\/internal\/guardrails\/settings$/);
    expect(init.method).toBe("GET");
    expect(init.headers["x-organization-id"]).toBe("7");
    expect(init.headers["x-role"]).toBe("Admin");
    expect(init.headers).toHaveProperty("x-internal-key");
    expect(init.signal).toBeDefined();
    expect(init.body).toBeUndefined();
  });

  it("omits tenant headers when none are given and serialises a body", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await aiGatewayRequest("POST", "/internal/x", { body: { a: 1 } });

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.headers).not.toHaveProperty("x-organization-id");
    expect(init.headers).not.toHaveProperty("x-role");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "nope" });

    await expect(aiGatewayRequest("GET", "/internal/x")).rejects.toThrow(/403/);
  });
});
