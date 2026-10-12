/**
 * Server-to-server calls to the AI Gateway's internal API.
 *
 * Same trust model as the proxy in routes/aiGateway.route.ts: the internal key
 * authenticates the backend, and the gateway trusts the organization and role
 * headers. Callers must pass the signed-in user's own organization and role
 * from the request, never values supplied by the client.
 */

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://127.0.0.1:8100";
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_INTERNAL_KEY || "";
const AI_GATEWAY_TIMEOUT_MS = 10_000;

export interface AiGatewayRequestOptions {
  organizationId?: number;
  role?: string;
  body?: object;
  /** Overrides the default timeout, for long-running calls such as the retention purge. */
  timeoutMs?: number;
}

/** Call an AI Gateway internal endpoint; throws on a non-2xx response or timeout. */
export async function aiGatewayRequest(
  method: string,
  path: string,
  options: AiGatewayRequestOptions = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-internal-key": AI_GATEWAY_KEY,
  };
  if (options.organizationId !== undefined) {
    headers["x-organization-id"] = String(options.organizationId);
  }
  if (options.role) headers["x-role"] = options.role;

  const response = await fetch(`${AI_GATEWAY_URL}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AIGateway ${path} returned ${response.status}: ${text}`);
  }
  return response.json();
}
