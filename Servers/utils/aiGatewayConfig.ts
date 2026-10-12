/**
 * AI Gateway connection settings, read once at load. The internal key is
 * trimmed here, so the header aiGatewayRequest sends and every "is the key
 * set?" check use the same value (an .env line with a trailing space or
 * newline would otherwise count as set but never match the gateway's key).
 */

const DEFAULT_AI_GATEWAY_URL = "http://127.0.0.1:8100";

/** Trim an environment value; undefined becomes "". */
export function normaliseEnvValue(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** The shared key sent as x-internal-key; "" when not set. */
export const AI_GATEWAY_INTERNAL_KEY = normaliseEnvValue(process.env.AI_GATEWAY_INTERNAL_KEY);

/** Whether AI_GATEWAY_URL is set, i.e. this deployment points at an AI Gateway. */
export const AI_GATEWAY_URL_CONFIGURED = normaliseEnvValue(process.env.AI_GATEWAY_URL) !== "";

export const AI_GATEWAY_URL =
  normaliseEnvValue(process.env.AI_GATEWAY_URL) || DEFAULT_AI_GATEWAY_URL;

/** Whether this backend has AI_GATEWAY_INTERNAL_KEY set. */
export function isGatewayInternalKeyConfigured(): boolean {
  return AI_GATEWAY_INTERNAL_KEY !== "";
}

/**
 * Whether to warn at startup: an AI Gateway is configured but the key is not,
 * so every internal call to it will be refused.
 */
export function shouldWarnMissingGatewayKey(): boolean {
  return AI_GATEWAY_URL_CONFIGURED && !isGatewayInternalKeyConfigured();
}
