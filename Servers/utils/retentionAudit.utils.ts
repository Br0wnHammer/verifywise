import { appendToAuditLedger } from "./auditLedger.utils";
import { logFailure } from "./logger/logHelper";
import { roleHasPermission } from "./rolePermissions.utils";

/**
 * Whether a caller may change organization-wide retention periods: the same
 * `organization.admin` permission the Data retention routes authorize on, so
 * a custom role granted it qualifies. A SuperAdmin (pure or elected, which
 * the auth middleware flags as req.isSuperAdmin whatever the org role) keeps
 * the access these handlers always gave it.
 */
export async function canChangeRetentionPeriods(caller: {
  organizationId: number | null | undefined;
  role: string | undefined;
  isSuperAdmin: boolean | undefined;
}): Promise<boolean> {
  if (caller.isSuperAdmin) return true;
  if (!caller.role) return false;
  return roleHasPermission(caller.organizationId ?? null, caller.role, "organization.admin");
}

/**
 * Leave a durable trace of a retention period change in the audit ledger.
 * The setting is already saved, so a failed append is logged and never fails
 * the request.
 */
export async function appendRetentionChangeToLedger(params: {
  organizationId: number;
  userId: number | null | undefined;
  description: string;
  functionName: string;
  fileName: string;
}): Promise<void> {
  const { organizationId, userId, description, functionName, fileName } = params;
  try {
    await appendToAuditLedger({
      organizationId,
      entryType: "event_log",
      userId: userId ?? null,
      eventType: "Update",
      entityType: "data_retention",
      description,
    });
  } catch (ledgerError) {
    await logFailure({
      eventType: "Update",
      description: `${description} but the audit ledger entry could not be written (organization ${organizationId}): ${(ledgerError as Error)?.message ?? ledgerError}`,
      functionName,
      fileName,
      userId: userId!,
      organizationId,
      error: ledgerError as Error,
    });
  }
}
