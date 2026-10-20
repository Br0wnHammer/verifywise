/**
 * The /v1 virtual key proxy must hand the gateway the request the client sent:
 * - the /v1 prefix, which Express strips because the router is mounted at /v1
 * - the JSON body, which the app-wide express.json() parser has already read
 *   from the stream, so it has to be written to the proxied request again
 *
 * http-proxy-middleware is ESM-only and mapped to a stub under Jest, so these
 * tests check the options the route passes to it.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const proxyOptions: any[] = [];
const fixRequestBody = jest.fn();
jest.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: (options: any) => {
    proxyOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  fixRequestBody: (...args: unknown[]) => fixRequestBody(...args),
}));

import virtualKeyProxyRoutes from "../virtualKeyProxy.route";

beforeEach(() => {
  proxyOptions.length = 0;
  fixRequestBody.mockClear();
});

describe("/v1 virtual key proxy forwarding", () => {
  it("puts back the /v1 prefix Express strips from the mounted path", () => {
    virtualKeyProxyRoutes();
    const { pathRewrite } = proxyOptions[0];

    expect(pathRewrite("/chat/completions")).toBe("/v1/chat/completions");
    expect(pathRewrite("/models?limit=5")).toBe("/v1/models?limit=5");
    expect(pathRewrite("/")).toBe("/v1/");
  });

  it("re-sends the body the JSON parser already consumed", () => {
    virtualKeyProxyRoutes();
    const proxyReq = { setHeader: jest.fn() };
    const req = { body: { model: "customer-faq-assistant", messages: [] } };

    proxyOptions[0].on.proxyReq(proxyReq, req, {});

    expect(fixRequestBody).toHaveBeenCalledWith(proxyReq, req);
  });
});
