/**
 * Audit ledger retention -- delete rule and checkpoint table (real database).
 *
 * audit_ledger is append-only. The retention job may delete rows only inside
 * a transaction that (a) sets verifywise.ledger_retention = 'on', (b) wrote a
 * checkpoint for the organization in that same transaction, (c) deletes only
 * rows at or below the checkpoint's pruned_through_id AND older than its
 * cutoff, and (d) uses a cutoff at least 12 months old. The checkpoint table
 * itself is append-only (organization cascade excepted).
 */

import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../../database/db";
import { GENESIS_HASH, computeEntryHash } from "../../utils/auditLedger.utils";
import { createTestOrganization, cleanupDatabase } from "./helpers";

jest.setTimeout(60000);

const SENTINEL = "pending".padEnd(64, "0");

describe("audit ledger retention delete rule", () => {
  let orgId: number;
  let ids: number[];

  /** Insert one correctly hashed ledger row with an explicit occurred_at. */
  async function insertLedgerRow(
    monthsAgo: number,
    description: string,
    prevHash: string,
  ): Promise<{ id: number; hash: string }> {
    const [rows] = (await sequelize.query(
      `INSERT INTO audit_ledger
         (organization_id, entry_type, user_id, occurred_at, event_type, description, entry_hash, prev_hash)
       VALUES (:orgId, 'event_log', NULL, now() - make_interval(months => :monthsAgo), 'Create',
               :description, :sentinel, :prevHash)
       RETURNING id, occurred_at`,
      {
        replacements: { orgId, monthsAgo, description, sentinel: SENTINEL, prevHash },
        type: QueryTypes.INSERT,
      },
    )) as unknown as [{ id: number; occurred_at: Date }[], number];
    const { id, occurred_at } = rows[0];
    const hash = computeEntryHash({
      id,
      entry_type: "event_log",
      user_id: null,
      occurred_at: occurred_at.toISOString(),
      event_type: "Create",
      entity_type: null,
      entity_id: null,
      action: null,
      field_name: null,
      old_value: null,
      new_value: null,
      description,
      prev_hash: prevHash,
    });
    await sequelize.query(`UPDATE audit_ledger SET entry_hash = :hash WHERE id = :id`, {
      replacements: { hash, id },
    });
    return { id: Number(id), hash };
  }

  async function insertCheckpoint(
    throughId: number,
    cutoffMonthsAgo: number,
    transaction?: Transaction,
  ): Promise<void> {
    await sequelize.query(
      `INSERT INTO audit_ledger_retention_checkpoints
         (organization_id, pruned_through_id, anchor_hash, cutoff, rows_deleted)
       VALUES (:orgId, :throughId, :hash, now() - make_interval(months => :cutoffMonthsAgo), 2)`,
      {
        replacements: { orgId, throughId, cutoffMonthsAgo, hash: "a".repeat(64) },
        transaction,
      },
    );
  }

  async function flagOn(transaction: Transaction): Promise<void> {
    await sequelize.query(`SELECT set_config('verifywise.ledger_retention', 'on', true)`, {
      transaction,
    });
  }

  function deleteIdsInOwnTransaction(
    idsToDelete: number[],
    opts: { checkpoint?: { throughId: number; cutoffMonthsAgo: number }; flag?: boolean },
  ): Promise<unknown> {
    return sequelize.transaction(async (transaction) => {
      if (opts.checkpoint) {
        await insertCheckpoint(
          opts.checkpoint.throughId,
          opts.checkpoint.cutoffMonthsAgo,
          transaction,
        );
      }
      if (opts.flag !== false) await flagOn(transaction);
      await sequelize.query(`DELETE FROM audit_ledger WHERE id IN (:idsToDelete)`, {
        replacements: { idsToDelete },
        transaction,
      });
    });
  }

  async function remainingIds(): Promise<number[]> {
    const rows = await sequelize.query<{ id: string }>(
      `SELECT id FROM audit_ledger WHERE organization_id = :orgId ORDER BY id`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    );
    return rows.map((r) => Number(r.id));
  }

  beforeEach(async () => {
    orgId = await createTestOrganization();
    // Five rows: the first four are 14 months old, the last is current.
    ids = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= 5; i++) {
      const { id, hash } = await insertLedgerRow(i <= 4 ? 14 : 0, `entry ${i}`, prev);
      ids.push(id);
      prev = hash;
    }
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
    await expect(deleteIdsInOwnTransaction([ids[0]], {})).rejects.toThrow(/append-only/);
  });

  it("rejects a same-transaction checkpointed delete when the flag is off", async () => {
    await expect(
      deleteIdsInOwnTransaction([ids[0]], {
        checkpoint: { throughId: ids[1], cutoffMonthsAgo: 13 },
        flag: false,
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("deletes old rows covered by a same-transaction checkpoint and rejects the first uncovered one", async () => {
    await deleteIdsInOwnTransaction([ids[0], ids[1]], {
      checkpoint: { throughId: ids[1], cutoffMonthsAgo: 13 },
    });
    expect(await remainingIds()).toEqual(ids.slice(2));

    await expect(
      deleteIdsInOwnTransaction([ids[2]], {
        checkpoint: { throughId: ids[1], cutoffMonthsAgo: 13 },
      }),
    ).rejects.toThrow(/append-only/);
    expect(await remainingIds()).toEqual(ids.slice(2));
  });

  it("does not let a checkpoint committed in an earlier transaction authorize a delete", async () => {
    await insertCheckpoint(ids[1], 13);
    await expect(deleteIdsInOwnTransaction([ids[0]], {})).rejects.toThrow(/append-only/);
    expect(await remainingIds()).toEqual(ids);
  });

  it("rejects a checkpoint whose cutoff is newer than 12 months", async () => {
    await expect(
      deleteIdsInOwnTransaction([ids[0]], {
        checkpoint: { throughId: ids[1], cutoffMonthsAgo: 6 },
      }),
    ).rejects.toThrow(/append-only/);
    expect(await remainingIds()).toEqual(ids);
  });

  it("rejects a row newer than the cutoff even when its id is covered", async () => {
    // ids[4] is current: id <= pruned_through_id, but occurred_at >= cutoff.
    await expect(
      deleteIdsInOwnTransaction([ids[4]], {
        checkpoint: { throughId: ids[4], cutoffMonthsAgo: 13 },
      }),
    ).rejects.toThrow(/append-only/);
    expect(await remainingIds()).toEqual(ids);
  });

  it("keeps the checkpoint table append-only", async () => {
    await insertCheckpoint(ids[1], 13);
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
    await insertCheckpoint(ids[1], 13);
    await sequelize.query(
      `INSERT INTO data_retention_settings (organization_id, audit_retention_months) VALUES (:orgId, 12)`,
      { replacements: { orgId } },
    );
    await sequelize.query(`DELETE FROM organizations WHERE id = :orgId`, {
      replacements: { orgId },
    });
    const countOf = async (table: string): Promise<number> => {
      const [row] = await sequelize.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = :orgId`,
        { replacements: { orgId }, type: QueryTypes.SELECT },
      );
      return Number(row.n);
    };
    expect(await countOf("audit_ledger")).toBe(0);
    expect(await countOf("audit_ledger_retention_checkpoints")).toBe(0);
    expect(await countOf("data_retention_settings")).toBe(0);
  });
});
