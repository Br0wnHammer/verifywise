/**
 * The AI Gateway's retention values for an organization that has not saved
 * its own settings (they match the gateway's _SETTINGS_DEFAULTS).
 */
export const GATEWAY_DEFAULTS = {
  log_retention_days: 90,
  spend_log_retention_days: 90,
  auto_purge_enabled: false,
} as const;

/**
 * Why the AI Gateway refused a retention purge, and the error recorded on the
 * failed run. The gateway's retention routes fail closed: with no internal
 * key configured they answer 503, and a key it does not accept gets 401.
 */
export const GATEWAY_PURGE_REFUSALS = {
  internal_key_not_configured: "Purge refused: internal key not configured",
  internal_key_rejected: "Purge refused: internal key rejected",
} as const;

export type GatewayPurgeRefusal = keyof typeof GATEWAY_PURGE_REFUSALS;

/** Whether this backend has AI_GATEWAY_INTERNAL_KEY set. */
export function isGatewayInternalKeyConfigured(): boolean {
  return Boolean((process.env.AI_GATEWAY_INTERNAL_KEY ?? "").trim());
}

/**
 * The refusal behind a failed gateway call, or null when it failed for
 * another reason. Without a key here the gateway can only refuse, so that is
 * "not configured" whatever it answered; a 503 means the gateway has none.
 */
export function gatewayPurgeRefusalFor(error: unknown): GatewayPurgeRefusal | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || (status !== 401 && status !== 503)) return null;
  if (status === 503 || !isGatewayInternalKeyConfigured()) {
    return "internal_key_not_configured";
  }
  return "internal_key_rejected";
}

/** Read the refusal back from a recorded run's error text. */
export function gatewayPurgeRefusalFromRunError(
  error: string | null | undefined,
): GatewayPurgeRefusal | null {
  if (!error) return null;
  const entry = Object.entries(GATEWAY_PURGE_REFUSALS).find(([, text]) => text === error);
  return entry ? (entry[0] as GatewayPurgeRefusal) : null;
}
