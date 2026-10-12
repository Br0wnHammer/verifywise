/**
 * AI Gateway connection settings: the single place the backend reads
 * AI_GATEWAY_URL and AI_GATEWAY_INTERNAL_KEY.
 *
 * Values are read from process.env on every call (nothing is memoised), so a
 * module imported before dotenv has loaded (the worker entry, tests) still
 * sees the configured values. Both are trimmed, matching the AI Gateway, which
 * trims its own key when it loads its settings: an .env line with a trailing
 * space or newline gives the same key on both sides, and a whitespace-only key
 * counts as not set on both sides.
 */

/**
 * Where the AI Gateway listens when AI_GATEWAY_URL is not set. Every gateway
 * call (internal API, proxies, the playground) has always used this address.
 */
export const DEFAULT_AI_GATEWAY_URL = "http://127.0.0.1:8100";

/** Trim an environment value; undefined becomes "". */
export function normaliseEnvValue(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** The shared key sent and checked as x-internal-key; "" when not set. */
export function getGatewayInternalKey(): string {
  return normaliseEnvValue(process.env.AI_GATEWAY_INTERNAL_KEY);
}

/** The AI Gateway base URL. */
export function getGatewayUrl(): string {
  return normaliseEnvValue(process.env.AI_GATEWAY_URL) || DEFAULT_AI_GATEWAY_URL;
}

/** Whether this backend has AI_GATEWAY_INTERNAL_KEY set. */
export function isGatewayInternalKeyConfigured(): boolean {
  return getGatewayInternalKey() !== "";
}

/**
 * Whether to warn at startup that the key is missing. The backend calls the
 * gateway at AI_GATEWAY_URL or, when that is unset, at the default address,
 * so the gateway is always in use and a missing key always matters: every
 * internal call, including the daily retention purge, will be refused.
 */
export function shouldWarnMissingGatewayKey(): boolean {
  return !isGatewayInternalKeyConfigured();
}

/** The startup warning text, shared by the API server and the worker. */
export function missingGatewayKeyWarning(): string {
  return (
    `AI_GATEWAY_INTERNAL_KEY is not set. The AI Gateway at ${getGatewayUrl()} will refuse ` +
    "this service's calls, including the daily retention purge (shown as 'Purge refused: " +
    "internal key not configured'). Set the same value here and in the AI Gateway."
  );
}
