import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../dataRetention.utils", () => ({ getGatewayAutoPurgeOrgIds: jest.fn() }));

import { warnIfGatewayKeyMissing } from "../aiGatewayKeyCheck";
import { getGatewayAutoPurgeOrgIds } from "../dataRetention.utils";

const mockOptedIn = getGatewayAutoPurgeOrgIds as unknown as jest.Mock<() => Promise<number[]>>;
const saved = { key: process.env.AI_GATEWAY_INTERNAL_KEY, url: process.env.AI_GATEWAY_URL };
const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const log = { warn: jest.fn() };

beforeEach(() => {
  log.warn.mockReset();
  mockOptedIn.mockReset();
  setEnv("AI_GATEWAY_INTERNAL_KEY", undefined);
  setEnv("AI_GATEWAY_URL", undefined);
});
afterEach(() => {
  setEnv("AI_GATEWAY_INTERNAL_KEY", saved.key);
  setEnv("AI_GATEWAY_URL", saved.url);
});

describe("warnIfGatewayKeyMissing", () => {
  it("stays quiet when the key is set", async () => {
    setEnv("AI_GATEWAY_INTERNAL_KEY", "k");
    setEnv("AI_GATEWAY_URL", "http://gw:8100");
    expect(await warnIfGatewayKeyMissing(log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(mockOptedIn).not.toHaveBeenCalled();
  });

  it("warns when AI_GATEWAY_URL is set, without querying the database", async () => {
    setEnv("AI_GATEWAY_URL", "http://gw:8100");
    expect(await warnIfGatewayKeyMissing(log)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("AI_GATEWAY_URL is set"));
    expect(mockOptedIn).not.toHaveBeenCalled();
  });

  it("warns when an organization has automatic gateway deletion on", async () => {
    mockOptedIn.mockResolvedValue([3, 4]);
    expect(await warnIfGatewayKeyMissing(log)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("2 organization(s) have automatic AI Gateway log deletion on"),
    );
  });

  it("stays quiet on an install that shows no sign of a gateway", async () => {
    mockOptedIn.mockResolvedValue([]);
    expect(await warnIfGatewayKeyMissing(log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("stays quiet when the check cannot run", async () => {
    mockOptedIn.mockRejectedValue(new Error("db not ready"));
    expect(await warnIfGatewayKeyMissing(log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
