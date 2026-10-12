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
  let cutoff: string | null = null;
  let deleted = 0;
  let capped = false;
  const failures: { name: string; error: unknown }[] = [];

  try {
    const months = await getAuditRetentionMonths(organizationId);
    if (months === null) return null;
    cutoff = await getAuditCutoff(months);
  } catch (error) {
    await safeRecordRun(organizationId, cutoff, 0, "failed", error);
    throw error;
  }
  const runCutoff = cutoff;

  const drain = async (name: string, deleteBatch: () => Promise<number>) => {
    try {
      for (let batches = 0; ; batches++) {
        if (batches >= RETENTION_MAX_BATCHES) {
          capped = true;
          return;
        }
        const n = await deleteBatch();
        deleted += n;
        if (n < RETENTION_BATCH_SIZE) return;
      }
    } catch (error) {
      // One failing table must not stop the rest of the org's run.
      failures.push({ name, error });
      logger.error(`Audit retention failed for ${name} in org ${organizationId}:`, error);
    }
  };

  await drain("audit_ledger", () =>
    pruneAuditLedgerBatch(organizationId, runCutoff, RETENTION_BATCH_SIZE),
  );
  for (const entry of AUDIT_RECORD_TABLES) {
    await drain(entry.table, () =>
      deleteAuditRowsBatch(organizationId, entry, runCutoff, RETENTION_BATCH_SIZE),
    );
  }

  if (deleted > 0) {
    try {
      await appendToAuditLedger({
        organizationId,
        entryType: "event_log",
        userId: null,
        eventType: "Delete",
        entityType: "audit_ledger",
        description: `Retention removed ${deleted} audit records before ${runCutoff.slice(0, 10)}`,
      });
    } catch (error) {
      logger.error(`Retention self-audit entry failed for org ${organizationId}:`, error);
    }
  }

  if (failures.length > 0) {
    const message = failures
      .map((f) => `${f.name}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join("; ");
    await safeRecordRun(organizationId, runCutoff, deleted, "failed", message);
  } else {
    await safeRecordRun(organizationId, runCutoff, deleted, capped ? "capped" : "success");
  }
  return { organization_id: organizationId, cutoff: runCutoff, deleted, capped };
}

async function safeRecordRun(
  organizationId: number,
  cutoff: string | null,
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
