/**
 * Virtual Key Proxy Routes — thin proxy to FastAPI AIGateway service.
 *
 * OpenAI-compatible /v1/* endpoints. No JWT required.
 * Virtual key authentication is handled by the AIGateway Python service.
 */

import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { Request, Router } from "express";
import { getGatewayUrl } from "../utils/aiGatewayConfig";

function virtualKeyProxyRoutes() {
  const router = Router();

  const proxy = createProxyMiddleware({
    // The startup fallback http-proxy-middleware requires; router below wins.
    target: getGatewayUrl(),
    // Resolve the gateway URL per request, so it follows AI_GATEWAY_URL as
    // read now rather than when the router was built.
    router: () => getGatewayUrl(),
    changeOrigin: true,
    // The router is mounted at /v1, so Express hands it "/chat/completions".
    // The gateway serves these routes under /v1, so put the prefix back.
    pathRewrite: (path: string) => `/v1${path}`,
    on: {
      // app.ts skips the JSON parser for /v1 so the raw body streams through.
      // If a parser has read the body anyway (another mount, a reordered
      // app.ts), write it to the proxied request again; otherwise the gateway
      // waits for a body that never arrives. No-op when nothing was parsed.
      proxyReq: (proxyReq, req) => {
        fixRequestBody(proxyReq, req as Request);
      },
      error: (err, req, res) => {
        const errAny = err as any;
        console.error(
          `[Virtual Key Proxy] Error for ${req.url}:`,
          errAny.message || errAny.code || errAny,
        );
        if (res && "writeHead" in res) {
          (res as any).writeHead(502, { "Content-Type": "application/json" });
          (res as any).end(
            JSON.stringify({
              error: "AI Gateway proxy error",
              message: errAny.message || errAny.code || "Unknown error",
            }),
          );
        }
      },
    },
  });

  router.use("/", proxy);

  return router;
}

export default virtualKeyProxyRoutes;
