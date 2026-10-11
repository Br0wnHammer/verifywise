import { QueryTypes } from "sequelize";
import { sequelize } from "../database/db";

export const EXPORT_BATCH_SIZE = 1000;

export const AUDIT_LEDGER_EXPORT_COLUMNS = [
  "id",
  "occurred_at",
  "user_id",
  "user",
  "entry_type",
  "event_type",
  "action",
  "entity_type",
  "entity_id",
  "field_name",
  "old_value",
  "new_value",
  "description",
  "entry_hash",
  "prev_hash",
] as const;

export interface AuditLedgerExportFilters {
  entityType?: string;
  entryType?: string;
}

/**
 * WHERE conditions shared by the ledger list and the export, so the same
 * filters always select the same rows. Tables are aliased `al`.
 */
export const ledgerFilterConditions = (
  organizationId: number,
  filters: AuditLedgerExportFilters,
): { conditions: string[]; replacements: Record<string, string | number> } => {
  const conditions = ["al.organization_id = :organizationId"];
  const replacements: Record<string, string | number> = { organizationId };
  if (filters.entityType) {
    conditions.push("al.entity_type = :entityType");
    replacements.entityType = filters.entityType;
  }
  if (filters.entryType) {
    conditions.push("al.entry_type = :entryType");
    replacements.entryType = filters.entryType;
  }
  return { conditions, replacements };
};

/** One batch of the org's ledger after `afterId`, oldest first. */
export const fetchAuditLedgerBatch = async (
  organizationId: number,
  filters: AuditLedgerExportFilters,
  afterId: number,
): Promise<any[]> => {
  const { conditions, replacements } = ledgerFilterConditions(organizationId, filters);
  conditions.push("al.id > :afterId");
  Object.assign(replacements, { afterId, limit: EXPORT_BATCH_SIZE });

  return sequelize.query(
    `SELECT al.*, u.name AS user_name, u.surname AS user_surname
       FROM audit_ledger al
       LEFT JOIN users u ON al.user_id = u.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY al.id ASC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT },
  );
};

/** A ledger row as CSV values, in AUDIT_LEDGER_EXPORT_COLUMNS order. */
export const ledgerRowValues = (row: any): unknown[] => [
  row.id,
  row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  row.user_id,
  [row.user_name, row.user_surname].filter(Boolean).join(" "),
  row.entry_type,
  row.event_type,
  row.action,
  row.entity_type,
  row.entity_id,
  row.field_name,
  row.old_value,
  row.new_value,
  row.description,
  row.entry_hash,
  row.prev_hash,
];
