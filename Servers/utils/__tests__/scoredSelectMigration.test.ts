import { describe, it, expect } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("../../database/migrations/20261010090000-add-scored-select-custom-field-type.js");

/** A fake queryInterface that records SQL; SELECTs return the given rows. */
function fakeQueryInterface(scoredCount = 0) {
  const statements: string[] = [];
  return {
    statements,
    sequelize: {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        return /^SELECT/i.test(sql.trim()) ? [[{ count: scoredCount }], {}] : [[], {}];
      },
    },
  };
}

describe("add-scored-select-custom-field-type migration", () => {
  it("up re-creates the field type CHECK with scored_select", async () => {
    const qi = fakeQueryInterface();
    await migration.up(qi);
    expect(qi.statements).toHaveLength(1);
    expect(qi.statements[0]).toContain("DROP CONSTRAINT IF EXISTS cfd_field_type_allowed");
    expect(qi.statements[0]).toContain(
      "CHECK (field_type IN ('text','number','date','boolean','select','multiselect','user','scored_select'))",
    );
  });

  it("down restores the original CHECK when no scored field exists", async () => {
    const qi = fakeQueryInterface(0);
    await migration.down(qi);
    expect(qi.statements[1]).toContain(
      "CHECK (field_type IN ('text','number','date','boolean','select','multiselect','user'))",
    );
  });

  it("down refuses to drop customer data when scored fields exist", async () => {
    const qi = fakeQueryInterface(2);
    await expect(migration.down(qi)).rejects.toThrow(/2 scored select/);
    expect(qi.statements).toHaveLength(1);
  });
});
