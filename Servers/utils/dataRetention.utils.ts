import { QueryTypes } from "sequelize";
import { sequelize } from "../database/db";

/** Allowed audit record retention periods in months; null (no row value) keeps records indefinitely. */
export const AUDIT_RETENTION_MONTHS = [12, 24, 36, 60, 84, 120] as const;

export const RETENTION_BATCH_SIZE = 10_000;
export const RETENTION_MAX_BATCHES = 500;

export type RetentionRecordType =
  | "audit_records"
  | "ai_gateway_guardrail_logs"
  | "ai_gateway_spend_logs"
  | "mrm_metrics"
  | "shadow_ai_events"
  | "shadow_ai_daily_rollups"
  | "shadow_ai_alert_history";

export type RetentionRunStatus = "success" | "capped" | "failed";

/**
 * Audit tables pruned by timestamp. The hash-chained audit_ledger is pruned
 * separately (see auditLedgerRetention.utils.ts) and is deliberately absent.
 * Names are interpolated into SQL, so they only ever come from this list.
 */
export const AUDIT_RECORD_TABLES: ReadonlyArray<{ table: string; timestampColumn: string }> = [
  { table: "event_logs", timestampColumn: "timestamp" },
  { table: "model_inventory_change_history", timestampColumn: "changed_at" },
  { table: "vendor_change_history", timestampColumn: "changed_at" },
  { table: "use_case_change_history", timestampColumn: "changed_at" },
  { table: "project_change_history", timestampColumn: "changed_at" },
  { table: "framework_change_history", timestampColumn: "changed_at" },
  { table: "evidence_hub_change_history", timestampColumn: "changed_at" },
  { table: "project_risk_change_history", timestampColumn: "changed_at" },
  { table: "vendor_risk_change_history", timestampColumn: "changed_at" },
  { table: "policy_change_history", timestampColumn: "changed_at" },
  { table: "incident_change_history", timestampColumn: "changed_at" },
  { table: "file_change_history", timestampColumn: "changed_at" },
  { table: "model_lifecycle_change_history", timestampColumn: "created_at" },
  { table: "task_change_history", timestampColumn: "changed_at" },
  { table: "training_change_history", timestampColumn: "changed_at" },
  { table: "model_risk_change_history", timestampColumn: "changed_at" },
  { table: "dataset_change_histories", timestampColumn: "changed_at" },
  { table: "ai_gateway_endpoint_change_history", timestampColumn: "changed_at" },
  { table: "ai_gateway_guardrail_change_history", timestampColumn: "changed_at" },
  { table: "ai_action_audit_log", timestampColumn: "created_at" },
  { table: "file_access_logs", timestampColumn: "access_date" },
];

type AuditTable = (typeof AUDIT_RECORD_TABLES)[number];

export async function getAuditRetentionMonths(organizationId: number): Promise<number | null> {
  const rows = (await sequelize.query(
    `SELECT audit_retention_months FROM data_retention_settings WHERE organization_id = :organizationId`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as { audit_retention_months: number | null }[];
  return rows.length > 0 && rows[0].audit_retention_months !== null
    ? Number(rows[0].audit_retention_months)
    : null;
}

export async function setAuditRetentionMonths(
  organizationId: number,
  months: number | null,
  userId: number | null,
): Promise<void> {
  await sequelize.query(
    `INSERT INTO data_retention_settings (organization_id, audit_retention_months, updated_at, updated_by)
     VALUES (:organizationId, :months, now(), :userId)
     ON CONFLICT (organization_id) DO UPDATE
       SET audit_retention_months = EXCLUDED.audit_retention_months,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
    { replacements: { organizationId, months, userId } },
  );
}

/** The cutoff timestamp for a period, computed in SQL (one source of truth). */
export async function getAuditCutoff(months: number): Promise<string> {
  const rows = (await sequelize.query(
    `SELECT (now() - make_interval(months => :months))::text AS cutoff`,
    { replacements: { months }, type: QueryTypes.SELECT },
  )) as { cutoff: string }[];
  return rows[0].cutoff;
}

/** Look the entry up by value so only listed names ever reach SQL. */
function resolveAuditTable(entry: { table: string; timestampColumn: string }): AuditTable {
  const found = AUDIT_RECORD_TABLES.find(
    (t) => t.table === entry.table && t.timestampColumn === entry.timestampColumn,
  );
  if (!found) throw new Error(`Not an audit record table: ${entry.table}`);
  return found;
}

/**
 * Delete up to `batchSize` of the oldest rows older than `cutoff` from one
 * audit table for one org. Returns the rows deleted; 0 when the table does not
 * exist in this deployment.
 */
export async function deleteAuditRowsBatch(
  organizationId: number,
  entry: { table: string; timestampColumn: string },
  cutoff: string,
  batchSize: number,
): Promise<number> {
  const { table, timestampColumn } = resolveAuditTable(entry);
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(`SELECT set_config('app.current_org', :org, true)`, {
      replacements: { org: String(organizationId) },
      type: QueryTypes.SELECT,
      transaction,
    });
    const exists = (await sequelize.query(`SELECT to_regclass('verifywise.' || :table) AS reg`, {
      replacements: { table },
      type: QueryTypes.SELECT,
      transaction,
    })) as { reg: string | null }[];
    if (!exists[0]?.reg) return 0;

    const [, meta] = (await sequelize.query(
      `DELETE FROM ${table} WHERE ctid IN (
         SELECT ctid FROM ${table}
          WHERE organization_id = :organizationId AND ${timestampColumn} < :cutoff
          ORDER BY ${timestampColumn} LIMIT :batchSize)`,
      { replacements: { organizationId, cutoff, batchSize }, transaction },
    )) as [unknown, any];
    return typeof meta === "number" ? meta : Number(meta?.rowCount ?? 0);
  });
}

/**
 * How many audit records a prune with this period would delete right now:
 * ledger rows below the same bound the prune uses, plus aged-out rows in each
 * existing audit table. Read-only.
 */
export async function countAuditRecordsBefore(
  organizationId: number,
  months: number,
): Promise<number> {
  const cutoff = await getAuditCutoff(months);
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(`SELECT set_config('app.current_org', :org, true)`, {
      replacements: { org: String(organizationId) },
      type: QueryTypes.SELECT,
      transaction,
    });
    const ledger = (await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM audit_ledger
        WHERE organization_id = :organizationId
          AND id < COALESCE(
            (SELECT MIN(id) FROM audit_ledger WHERE organization_id = :organizationId AND occurred_at >= :cutoff),
            (SELECT MAX(id) FROM audit_ledger WHERE organization_id = :organizationId))`,
      { replacements: { organizationId, cutoff }, type: QueryTypes.SELECT, transaction },
    )) as { n: number }[];
    let total = Number(ledger[0]?.n ?? 0);

    for (const { table, timestampColumn } of AUDIT_RECORD_TABLES) {
      const exists = (await sequelize.query(`SELECT to_regclass('verifywise.' || :table) AS reg`, {
        replacements: { table },
        type: QueryTypes.SELECT,
        transaction,
      })) as { reg: string | null }[];
      if (!exists[0]?.reg) continue;
      const rows = (await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM ${table}
          WHERE organization_id = :organizationId AND ${timestampColumn} < :cutoff`,
        { replacements: { organizationId, cutoff }, type: QueryTypes.SELECT, transaction },
      )) as { n: number }[];
      total += Number(rows[0]?.n ?? 0);
    }
    return total;
  });
}

export interface RetentionRunInput {
  organizationId: number;
  recordType: RetentionRecordType;
  cutoff: string | null;
  deletedCount: number;
  status: RetentionRunStatus;
  error?: string | null;
}

export async function recordRetentionRun(row: RetentionRunInput): Promise<void> {
  await sequelize.query(
    `INSERT INTO data_retention_runs
       (organization_id, record_type, cutoff, deleted_count, status, error)
     VALUES (:organizationId, :recordType, :cutoff, :deletedCount, :status, :error)`,
    {
      replacements: {
        organizationId: row.organizationId,
        recordType: row.recordType,
        cutoff: row.cutoff,
        deletedCount: row.deletedCount,
        status: row.status,
        error: row.error ?? null,
      },
    },
  );
}

export type LatestRetentionRuns = Record<
  RetentionRecordType,
  { ran_at: string; deleted_count: number; status: RetentionRunStatus } | undefined
>;

export async function getLatestRetentionRuns(organizationId: number): Promise<LatestRetentionRuns> {
  const rows = (await sequelize.query(
    `SELECT DISTINCT ON (record_type) record_type, ran_at, deleted_count, status
       FROM data_retention_runs
      WHERE organization_id = :organizationId
      ORDER BY record_type, ran_at DESC, id DESC`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as any[];
  const result = {} as LatestRetentionRuns;
  for (const r of rows) {
    result[r.record_type as RetentionRecordType] = {
      ran_at: r.ran_at instanceof Date ? r.ran_at.toISOString() : String(r.ran_at),
      deleted_count: Number(r.deleted_count),
      status: r.status,
    };
  }
  return result;
}
