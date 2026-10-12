/**
 * The AI Gateway's retention values for an organization that has not saved
 * its own settings (they match the gateway's _SETTINGS_DEFAULTS).
 */
export const GATEWAY_DEFAULTS = {
  log_retention_days: 90,
  spend_log_retention_days: 90,
  auto_purge_enabled: false,
} as const;
