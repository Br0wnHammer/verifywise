import { appendToAuditLedger } from "./auditLedger.utils";
import { logFailure } from "./logger/logHelper";

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
