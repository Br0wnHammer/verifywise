import { afterEach, describe, expect, it } from "@jest/globals";
import {
  gatewayPurgeRefusalFor,
  gatewayPurgeRefusalFromRunError,
  isGatewayInternalKeyConfigured,
} from "../aiGatewayRetention.constants";

const savedKey = process.env.AI_GATEWAY_INTERNAL_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.AI_GATEWAY_INTERNAL_KEY;
  else process.env.AI_GATEWAY_INTERNAL_KEY = savedKey;
});

describe("gateway purge refusals", () => {
  it("reads whether this backend has the internal key", () => {
    process.env.AI_GATEWAY_INTERNAL_KEY = "  ";
    expect(isGatewayInternalKeyConfigured()).toBe(false);
    process.env.AI_GATEWAY_INTERNAL_KEY = "k";
    expect(isGatewayInternalKeyConfigured()).toBe(true);
  });

  it("classifies 503 and 401 responses", () => {
    process.env.AI_GATEWAY_INTERNAL_KEY = "k";
    expect(gatewayPurgeRefusalFor({ status: 503 })).toBe("internal_key_not_configured");
    expect(gatewayPurgeRefusalFor({ status: 401 })).toBe("internal_key_rejected");
    expect(gatewayPurgeRefusalFor({ status: 500 })).toBeNull();
    expect(gatewayPurgeRefusalFor(new Error("ECONNREFUSED"))).toBeNull();
    expect(gatewayPurgeRefusalFor(null)).toBeNull();
    delete process.env.AI_GATEWAY_INTERNAL_KEY;
    expect(gatewayPurgeRefusalFor({ status: 401 })).toBe("internal_key_not_configured");
  });

  it("reads the refusal back from a run's error text", () => {
    expect(gatewayPurgeRefusalFromRunError("Purge refused: internal key rejected")).toBe(
      "internal_key_rejected",
    );
    expect(gatewayPurgeRefusalFromRunError("db down")).toBeNull();
    expect(gatewayPurgeRefusalFromRunError(null)).toBeNull();
  });
});
