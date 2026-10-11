import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../../database/db", () => ({
  sequelize: { query: jest.fn() },
}));

import { sequelize } from "../../database/db";
import {
  fetchAuditLedgerBatch,
  ledgerRowValues,
  AUDIT_LEDGER_EXPORT_COLUMNS,
  EXPORT_BATCH_SIZE,
} from "../auditLedgerExport.utils";

const query = sequelize.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;

describe("fetchAuditLedgerBatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue([]);
  });

  it("scopes by organization, keyset pages oldest first and limits", async () => {
    await fetchAuditLedgerBatch(7, {}, 42);
    const [sql, opts] = query.mock.calls[0] as [string, any];
    expect(sql).toContain("al.organization_id = :organizationId");
    expect(sql).toContain("al.id > :afterId");
    expect(sql).toContain("ORDER BY al.id ASC");
    expect(sql).toContain("LIMIT :limit");
    expect(sql).not.toContain("al.entity_type");
    expect(sql).not.toContain("al.entry_type");
    expect(opts.replacements).toEqual({
      organizationId: 7,
      afterId: 42,
      limit: EXPORT_BATCH_SIZE,
    });
  });

  it("adds the entity type and entry type filters only when given", async () => {
    await fetchAuditLedgerBatch(7, { entityType: "vendor", entryType: "change_history" }, 0);
    const [sql, opts] = query.mock.calls[0] as [string, any];
    expect(sql).toContain("al.entity_type = :entityType");
    expect(sql).toContain("al.entry_type = :entryType");
    expect(opts.replacements.entityType).toBe("vendor");
    expect(opts.replacements.entryType).toBe("change_history");
  });
});

describe("ledgerRowValues", () => {
  const row = {
    id: 1,
    occurred_at: new Date("2026-10-11T00:00:00.000Z"),
    user_id: 3,
    user_name: "Ada",
    user_surname: "Lovelace",
    entry_type: "change_history",
    event_type: "Update",
    action: "update",
    entity_type: "vendor",
    entity_id: 9,
    field_name: "name",
    old_value: "a",
    new_value: "b",
    description: "d",
    entry_hash: "h1",
    prev_hash: "h0",
  };

  it("returns values in column order", () => {
    expect(ledgerRowValues(row)).toEqual([
      1,
      "2026-10-11T00:00:00.000Z",
      3,
      "Ada Lovelace",
      "change_history",
      "Update",
      "update",
      "vendor",
      9,
      "name",
      "a",
      "b",
      "d",
      "h1",
      "h0",
    ]);
    expect(ledgerRowValues(row)).toHaveLength(AUDIT_LEDGER_EXPORT_COLUMNS.length);
  });

  it("gives an empty user for a deleted user", () => {
    const values = ledgerRowValues({ ...row, user_id: null, user_name: null, user_surname: null });
    expect(values[3]).toBe("");
  });
});
