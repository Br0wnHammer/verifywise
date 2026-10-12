jest.mock("../../database/db", () => ({
  sequelize: {
    query: jest.fn(),
    transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({ id: "txn" })),
  },
}));

import { ENTITY_CONFIGS } from "../../config/changeHistory.config";
import { sequelize } from "../../database/db";
import {
  AUDIT_RECORD_TABLES,
  countAuditRecordsBefore,
  deleteAuditRowsBatch,
  getLatestRetentionRuns,
  recordRetentionRun,
} from "../dataRetention.utils";

const mockQuery = sequelize.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe("AUDIT_RECORD_TABLES", () => {
  it("covers every change-history entity table", () => {
    const names = AUDIT_RECORD_TABLES.map((t) => t.table);
    for (const config of Object.values(ENTITY_CONFIGS)) {
      expect(names).toContain(config.tableName);
    }
  });

  it("includes the FRIA change history", () => {
    expect(AUDIT_RECORD_TABLES).toContainEqual({
      table: "fria_change_history",
      timestampColumn: "changed_at",
    });
  });

  it("only contains plain identifiers and never the ledger itself", () => {
    for (const { table, timestampColumn } of AUDIT_RECORD_TABLES) {
      expect(table).toMatch(/^[a-z_]+$/);
      expect(timestampColumn).toMatch(/^[a-z_]+$/);
      expect(table).not.toBe("audit_ledger");
    }
  });
});

describe("deleteAuditRowsBatch", () => {
  it("throws for a table that is not in the list", async () => {
    await expect(
      deleteAuditRowsBatch(1, { table: "users", timestampColumn: "created_at" }, "2020-01-01", 10),
    ).rejects.toThrow(/Not an audit record table/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when the column does not match the listed table", async () => {
    await expect(
      deleteAuditRowsBatch(
        1,
        { table: "event_logs", timestampColumn: "1; DROP TABLE users" },
        "2020-01-01",
        10,
      ),
    ).rejects.toThrow(/Not an audit record table/);
  });

  it("returns 0 without deleting when the table does not exist", async () => {
    mockQuery
      .mockResolvedValueOnce([{}]) // set_config
      .mockResolvedValueOnce([{ reg: null }]); // to_regclass
    const n = await deleteAuditRowsBatch(1, AUDIT_RECORD_TABLES[0], "2020-01-01", 10);
    expect(n).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("DELETE"))).toBe(false);
  });

  it("deletes a batch scoped to the org and returns the row count", async () => {
    mockQuery
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ reg: "event_logs" }])
      .mockResolvedValueOnce([undefined, { rowCount: 7 }]);
    const n = await deleteAuditRowsBatch(4, AUDIT_RECORD_TABLES[0], "2020-01-01", 10);
    expect(n).toBe(7);
    const [sql, opts] = mockQuery.mock.calls[2];
    expect(sql).toContain("DELETE FROM event_logs");
    expect(sql).toContain("organization_id = :organizationId");
    expect(opts.replacements).toEqual({ organizationId: 4, cutoff: "2020-01-01", batchSize: 10 });
  });
});

describe("countAuditRecordsBefore", () => {
  it("sums the ledger bound count and each existing table", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("AS cutoff")) return [{ cutoff: "2020-01-01 00:00:00+00" }];
      if (sql.includes("set_config")) return [{}];
      if (sql.includes("FROM audit_ledger")) return [{ n: 5 }];
      if (sql.includes("to_regclass")) return [{ reg: "x" }];
      return [{ n: 2 }];
    });
    const total = await countAuditRecordsBefore(1, 24);
    expect(total).toBe(5 + 2 * AUDIT_RECORD_TABLES.length);
  });
});

describe("recordRetentionRun / getLatestRetentionRuns", () => {
  it("inserts the run with a null error by default", async () => {
    mockQuery.mockResolvedValue([]);
    await recordRetentionRun({
      organizationId: 1,
      recordType: "audit_records",
      cutoff: null,
      deletedCount: 3,
      status: "success",
    });
    expect(mockQuery.mock.calls[0][1].replacements).toMatchObject({
      organizationId: 1,
      recordType: "audit_records",
      deletedCount: 3,
      error: null,
    });
  });

  it("returns the latest run per record type", async () => {
    mockQuery.mockResolvedValue([
      {
        record_type: "audit_records",
        ran_at: new Date("2026-01-02T00:00:00Z"),
        deleted_count: "9",
        status: "capped",
      },
    ]);
    const runs = await getLatestRetentionRuns(1);
    expect(mockQuery.mock.calls[0][0]).toContain("DISTINCT ON (record_type)");
    expect(runs.audit_records).toEqual({
      ran_at: "2026-01-02T00:00:00.000Z",
      deleted_count: 9,
      status: "capped",
    });
    expect(runs.mrm_metrics).toBeUndefined();
  });
});
