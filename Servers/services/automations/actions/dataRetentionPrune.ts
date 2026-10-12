import { getAllOrganizationsQuery } from "../../../utils/organization.utils";
import { appendToAuditLedger } from "../../../utils/auditLedger.utils";
import { pruneAuditLedgerBatch } from "../../../utils/auditLedgerRetention.utils";
import {
  AUDIT_RECORD_TABLES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  deleteAuditRowsBatch,
  getAuditCutoff,
  getAuditRetentionMonths,
  recordRetentionRun,
} from "../../../utils/dataRetention.utils";
import logger from "../../../utils/logger/fileLogger";

/**
 * Daily audit record retention. An org with no audit retention period is
 * skipped entirely. Otherwise the hash-chained ledger is pruned from its
 * oldest end (with checkpoints), then each audit table by timestamp, in
 * batches of 10k capped at 500 batches per table; the daily job picks up any
 * remainder the next day. One `audit_records` run is recorded per org.
 */

export interface DataRetentionSummary {
  organization_id: number;
  cutoff: string;
  deleted: number;
  capped: boolean;
}

export async function runDataRetentionPrune(
  organizationId: number,
): Promise<DataRetentionSummary | null> {
  const months = await getAuditRetentionMonths(organizationId);
  if (months === null) return null;

  const cutoff = await getAuditCutoff(months);
  let deleted = 0;
  let capped = false;

  try {
    const drain = async (deleteBatch: () => Promise<number>) => {
      for (let batches = 0; ; batches++) {
        if (batches >= RETENTION_MAX_BATCHES) {
          capped = true;
          return;
        }
        const n = await deleteBatch();
        deleted += n;
        if (n < RETENTION_BATCH_SIZE) return;
      }
    };

    await drain(() => pruneAuditLedgerBatch(organizationId, cutoff, RETENTION_BATCH_SIZE));
    for (const entry of AUDIT_RECORD_TABLES) {
      await drain(() => deleteAuditRowsBatch(organizationId, entry, cutoff, RETENTION_BATCH_SIZE));
    }
  } catch (error) {
    await safeRecordRun(organizationId, cutoff, deleted, "failed", error);
    throw error;
  }

  if (deleted > 0) {
    try {
      await appendToAuditLedger({
        organizationId,
        entryType: "event_log",
        userId: null,
        eventType: "Delete",
        entityType: "audit_ledger",
        description: `Retention removed ${deleted} audit records before ${cutoff.slice(0, 10)}`,
      });
    } catch (error) {
      logger.error(`Retention self-audit entry failed for org ${organizationId}:`, error);
    }
  }

  await safeRecordRun(organizationId, cutoff, deleted, capped ? "capped" : "success");
  return { organization_id: organizationId, cutoff, deleted, capped };
}

async function safeRecordRun(
  organizationId: number,
  cutoff: string,
  deletedCount: number,
  status: "success" | "capped" | "failed",
  error?: unknown,
): Promise<void> {
  try {
    await recordRetentionRun({
      organizationId,
      recordType: "audit_records",
      cutoff,
      deletedCount,
      status,
      error: error === undefined ? null : error instanceof Error ? error.message : String(error),
    });
  } catch (recordError) {
    logger.error(`Recording retention run failed for org ${organizationId}:`, recordError);
  }
}

/** Prune every org -- the BullMQ daily job entry point. One org's failure never blocks the rest. */
export async function runDataRetentionPruneAllOrgs(): Promise<void> {
  const organizations = await getAllOrganizationsQuery();
  for (const org of organizations) {
    if (org.id === undefined || org.id === null) continue;
    try {
      const summary = await runDataRetentionPrune(org.id);
      if (summary && (summary.deleted > 0 || summary.capped)) {
        logger.info(
          `Audit retention prune org ${org.id}: deleted=${summary.deleted} capped=${summary.capped} cutoff=${summary.cutoff}`,
        );
      }
    } catch (error) {
      logger.error(`Audit retention prune failed for org ${org.id}:`, error);
    }
  }
}
