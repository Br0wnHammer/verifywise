import { describe, it, expect } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("../../database/migrations/20261012091252-shadow-ai-settings-unique-org.js");

describe("shadow-ai-settings-unique-org migration", () => {
  it("removes duplicate rows before adding the unique index, in one transaction", async () => {
    const statements: { sql: string; inTransaction: boolean }[] = [];
    const tx = {};
    const query = async (sql: string, options?: { transaction?: unknown }) => {
      statements.push({
        sql: sql.replace(/\s+/g, " ").trim(),
        inTransaction: options?.transaction === tx,
      });
      return [[]];
    };

    await migration.up({ sequelize: { query, transaction: async (fn: any) => fn(tx) } });

    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toMatch(/^DELETE FROM verifywise\.shadow_ai_settings/);
    expect(statements[0].sql).toContain("PARTITION BY organization_id");
    expect(statements[1].sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_ai_settings_organization_id",
    );
    expect(statements.every((s) => s.inTransaction)).toBe(true);
  });

  it("drops the index on rollback", async () => {
    const statements: string[] = [];
    await migration.down({
      sequelize: { query: async (sql: string) => statements.push(sql) },
    });
    expect(statements).toEqual([
      "DROP INDEX IF EXISTS verifywise.uq_shadow_ai_settings_organization_id;",
    ]);
  });
});
