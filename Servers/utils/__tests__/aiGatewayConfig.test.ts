import { afterEach, describe, expect, it, jest } from "@jest/globals";

const saved = {
  key: process.env.AI_GATEWAY_INTERNAL_KEY,
  url: process.env.AI_GATEWAY_URL,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("AI_GATEWAY_INTERNAL_KEY", saved.key);
  restore("AI_GATEWAY_URL", saved.url);
});

/** Load the config module fresh with the given environment. */
function loadWith(env: { key?: string; url?: string }): typeof import("../aiGatewayConfig") {
  restore("AI_GATEWAY_INTERNAL_KEY", env.key);
  restore("AI_GATEWAY_URL", env.url);
  let mod: typeof import("../aiGatewayConfig") | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../aiGatewayConfig");
  });
  return mod!;
}

describe("aiGatewayConfig", () => {
  it("trims the internal key, so the header and the check use the same value", () => {
    const config = loadWith({ key: "  secret-key\n", url: "http://gw:8100" });
    expect(config.AI_GATEWAY_INTERNAL_KEY).toBe("secret-key");
    expect(config.isGatewayInternalKeyConfigured()).toBe(true);
  });

  it("treats a whitespace-only key as not set", () => {
    const config = loadWith({ key: " \n\t", url: "http://gw:8100" });
    expect(config.AI_GATEWAY_INTERNAL_KEY).toBe("");
    expect(config.isGatewayInternalKeyConfigured()).toBe(false);
  });

  it("warns only when a gateway URL is configured and the key is missing", () => {
    expect(loadWith({ url: "http://gw:8100" }).shouldWarnMissingGatewayKey()).toBe(true);
    expect(loadWith({ key: "k", url: "http://gw:8100" }).shouldWarnMissingGatewayKey()).toBe(false);
    expect(loadWith({}).shouldWarnMissingGatewayKey()).toBe(false);
    expect(loadWith({ url: "  " }).shouldWarnMissingGatewayKey()).toBe(false);
  });

  it("falls back to the default gateway URL", () => {
    expect(loadWith({}).AI_GATEWAY_URL).toBe("http://127.0.0.1:8100");
    expect(loadWith({ url: " http://gw:8100\n" }).AI_GATEWAY_URL).toBe("http://gw:8100");
  });
});
