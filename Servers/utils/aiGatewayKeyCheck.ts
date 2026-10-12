/**
 * Startup check for a missing AI_GATEWAY_INTERNAL_KEY, shared by the API
 * server and the worker.
 *
 * Rule: warn only when the key is missing AND the gateway is evidently in
 * use, meaning AI_GATEWAY_URL is set explicitly, or at least one organization
 * has automatic AI Gateway log deletion on (a single local query on the
 * gateway's settings table, skipped when that table does not exist). An
 * install that runs no gateway stays quiet. If the query fails the check
 * stays quiet too; the daily purge still logs a refusal once per run.
 */

import {
  isGatewayInternalKeyConfigured,
  isGatewayUrlConfigured,
  missingGatewayKeyWarning,
} from "./aiGatewayConfig";
import { getGatewayAutoPurgeOrgIds } from "./dataRetention.utils";

export async function warnIfGatewayKeyMissing(log: {
  warn: (message: string) => unknown;
}): Promise<boolean> {
  if (isGatewayInternalKeyConfigured()) return false;
  let reason: string | null = null;
  if (isGatewayUrlConfigured()) {
    reason = "AI_GATEWAY_URL is set";
  } else {
    try {
      const orgIds = await getGatewayAutoPurgeOrgIds();
      if (orgIds.length > 0) {
        reason = `${orgIds.length} organization(s) have automatic AI Gateway log deletion on`;
      }
    } catch {
      // Cannot tell whether the gateway is in use; stay quiet.
    }
  }
  if (!reason) return false;
  log.warn(missingGatewayKeyWarning(reason));
  return true;
}
