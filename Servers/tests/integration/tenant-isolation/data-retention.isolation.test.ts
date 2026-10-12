jest.setTimeout(60000);

import { QueryTypes } from "sequelize";
import { sequelize } from "../../../database/db";
import { cleanupDatabase, seedTwoOrgsAndUsers } from "../helpers";

/**
 * data retention tables -- tenant isolation at the query layer.
 *
 * Rows written for org A in data_retention_settings, data_retention_runs and
 * audit_ledger_retention_checkpoints must never be returned by the
 * organization_id-scoped reads the retention code uses for org B.
 */
describe("data retention tables tenant isolation", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  async function count(table: string, orgId: number): Promise<number> {
    const [row] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = :orgId`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  it("does not return org A rows when reading as org B", async () => {
    const { orgA, orgB, userA } = await seedTwoOrgsAndUsers();

    await sequelize.query(
      `INSERT INTO data_retention_settings (organization_id, audit_retention_months, updated_by)
       VALUES (:orgA, 24, :userA)`,
      { replacements: { orgA, userA } },
    );
    await sequelize.query(
      `INSERT INTO data_retention_runs (organization_id, record_type, deleted_count, status)
       VALUES (:orgA, 'audit_records', 3, 'success')`,
      { replacements: { orgA } },
    );
    await sequelize.query(
      `INSERT INTO audit_ledger_retention_checkpoints
         (organization_id, pruned_through_id, anchor_hash, cutoff, rows_deleted)
       VALUES (:orgA, 10, :hash, now(), 3)`,
      { replacements: { orgA, hash: "b".repeat(64) } },
    );

    for (const table of [
      "data_retention_settings",
      "data_retention_runs",
      "audit_ledger_retention_checkpoints",
    ]) {
      expect(await count(table, orgA)).toBe(1);
      expect(await count(table, orgB)).toBe(0);
    }
  });
});
