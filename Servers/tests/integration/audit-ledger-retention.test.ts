/**
 * Audit ledger retention -- delete rule and checkpoint table (real database).
 *
 * audit_ledger is append-only. The retention job may delete rows only inside
 * a transaction that sets verifywise.ledger_retention = 'on' AND only rows at
 * or below a checkpoint's pruned_through_id for the same organization. The
 * checkpoint table itself is append-only (organization cascade excepted).
 */

import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import { appendToAuditLedger } from "../../utils/auditLedger.utils";
import { createTestOrganization, cleanupDatabase } from "./helpers";

jest.setTimeout(60000);

describe("audit ledger retention delete rule", () => {
  let orgId: number;
  let ids: number[];

  async function insertCheckpoint(throughId: number, transaction?: Transaction): Promise<void> {
    await sequelize.query(
      `INSERT INTO audit_ledger_retention_checkpoints
         (organization_id, pruned_through_id, anchor_hash, cutoff, rows_deleted)
       VALUES (:orgId, :throughId, :hash, now(), 2)`,
      {
        replacements: { orgId, throughId, hash: "a".repeat(64) },
        transaction,
      },
    );
  }

  beforeEach(async () => {
    orgId = await createTestOrganization();
    for (let i = 1; i <= 5; i++) {
      await appendToAuditLedger({
        organizationId: orgId,
        entryType: "event_log",
        userId: null,
        eventType: "Create",
        description: `entry ${i}`,
      });
    }
    const rows = await sequelize.query<{ id: string }>(
      `SELECT id FROM audit_ledger WHERE organization_id = :orgId ORDER BY id`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    ids = rows.map((r) => Number(r.id));
    expect(ids).toHaveLength(5);
  });

  afterEach(async () => {
    await cleanupDatabase();
  });

  it("rejects a plain delete", async () => {
    await expect(
      sequelize.query(`DELETE FROM audit_ledger WHERE id = :id`, {
        replacements: { id: ids[0] },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects a flagged delete when no checkpoint exists", async () => {
    await expect(
      sequelize.transaction(async (transaction) => {
        await sequelize.query(`SELECT set_config('verifywise.ledger_retention', 'on', true)`, {
          transaction,
        });
        await sequelize.query(`DELETE FROM audit_ledger WHERE id = :id`, {
          replacements: { id: ids[0] },
          transaction,
        });
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects a checkpointed delete when the flag is off", async () => {
    await insertCheckpoint(ids[1]);
    await expect(
      sequelize.query(`DELETE FROM audit_ledger WHERE id = :id`, {
        replacements: { id: ids[0] },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("deletes rows covered by a checkpoint and rejects the first uncovered one", async () => {
    await sequelize.transaction(async (transaction) => {
      await insertCheckpoint(ids[1], transaction);
      await sequelize.query(`SELECT set_config('verifywise.ledger_retention', 'on', true)`, {
        transaction,
      });
      await sequelize.query(
        `DELETE FROM audit_ledger WHERE organization_id = :orgId AND id <= :through`,
        { replacements: { orgId, through: ids[1] }, transaction },
      );
    });

    const remaining = await sequelize.query<{ id: string }>(
      `SELECT id FROM audit_ledger WHERE organization_id = :orgId ORDER BY id`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    expect(remaining.map((r) => Number(r.id))).toEqual(ids.slice(2));

    await expect(
      sequelize.transaction(async (transaction) => {
        await sequelize.query(`SELECT set_config('verifywise.ledger_retention', 'on', true)`, {
          transaction,
        });
        await sequelize.query(`DELETE FROM audit_ledger WHERE id = :id`, {
          replacements: { id: ids[2] },
          transaction,
        });
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("keeps the checkpoint table append-only", async () => {
    await insertCheckpoint(ids[1]);
    await expect(
      sequelize.query(
        `UPDATE audit_ledger_retention_checkpoints SET rows_deleted = 9 WHERE organization_id = :orgId`,
        { replacements: { orgId } },
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sequelize.query(
        `DELETE FROM audit_ledger_retention_checkpoints WHERE organization_id = :orgId`,
        { replacements: { orgId } },
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("cascades both tables when the organization is deleted", async () => {
    await insertCheckpoint(ids[1]);
    await sequelize.query(
      `INSERT INTO data_retention_settings (organization_id, audit_retention_months) VALUES (:orgId, 12)`,
      { replacements: { orgId } },
    );
    await sequelize.query(`DELETE FROM organizations WHERE id = :orgId`, {
      replacements: { orgId },
    });
    const [ledger] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM audit_ledger WHERE organization_id = :orgId`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    const [checkpoints] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM audit_ledger_retention_checkpoints WHERE organization_id = :orgId`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    const [settings] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM data_retention_settings WHERE organization_id = :orgId`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    expect(Number(ledger.n)).toBe(0);
    expect(Number(checkpoints.n)).toBe(0);
    expect(Number(settings.n)).toBe(0);
  });
});
