import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockQuery = jest.fn(async (..._args: any[]): Promise<any> => []);
const mockTx = {
  id: "tx",
  commit: jest.fn(async () => undefined),
  rollback: jest.fn(async () => undefined),
};
jest.mock("../../database/db", () => ({
  sequelize: {
    query: (...args: any[]) => mockQuery(...args),
    transaction: async () => mockTx,
  },
}));
const mockAppend = jest.fn(async (..._args: any[]) => undefined);
jest.mock("../auditLedger.utils", () => ({
  appendToAuditLedger: (...args: any[]) => mockAppend(...args),
}));

import { createCustomFieldDefinitionQuery, setCustomFieldValueQuery } from "../customField.utils";

const ORG = 7;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim();

const scoredDef = {
  id: 11,
  organization_id: ORG,
  entity_type: "project",
  field_key: "feasibility",
  label: "Technical feasibility",
  field_type: "scored_select",
  options: [
    { id: "opt_00000001", label: "High", score: 3 },
    { id: "opt_00000002", label: "Medium", score: 2 },
  ],
  required: false,
};
const selectDef = { ...scoredDef, id: 12, field_type: "select", options: ["US", "EU"] };
const multiDef = { ...scoredDef, id: 13, field_type: "multiselect", options: ["a", "b"] };

/** Route each SQL statement to a canned answer. */
function serve(def: unknown) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = flat(sql);
    if (s.startsWith("SELECT * FROM custom_field_definitions")) return [def];
    if (s.startsWith("SELECT 1 AS ok FROM")) return [{ ok: 1 }];
    if (s.startsWith("INSERT INTO custom_field_values")) return [{ id: 1, definition_id: 11 }];
    if (s.startsWith("INSERT INTO custom_field_definitions")) return [{ ...scoredDef, id: 99 }];
    return [];
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockAppend.mockReset();
});

describe("creating a scored select definition", () => {
  it("stores validated options with server-assigned ids", async () => {
    serve(scoredDef);
    await createCustomFieldDefinitionQuery(
      {
        entity_type: "project",
        field_key: "feasibility",
        label: "Technical feasibility",
        field_type: "scored_select",
        options: [
          { label: "High", score: 3 },
          { label: "Low", score: 1.005 },
        ],
      },
      ORG,
      3,
    );
    const insert = mockQuery.mock.calls.find((c) =>
      flat(c[0]).startsWith("INSERT INTO custom_field_definitions"),
    )!;
    const stored = JSON.parse((insert[1] as any).replacements.options);
    expect(stored.map((o: any) => o.label)).toEqual(["High", "Low"]);
    stored.forEach((o: any) => expect(o.id).toMatch(/^opt_[0-9a-f]{8}$/));
    expect((insert[1] as any).replacements.field_type).toBe("scored_select");
  });

  it("rejects option objects on a plain select", async () => {
    await expect(
      createCustomFieldDefinitionQuery(
        {
          entity_type: "project",
          field_key: "region",
          label: "Region",
          field_type: "select",
          options: [{ label: "US", score: 1 }] as any,
        },
        ORG,
        3,
      ),
    ).rejects.toThrow(/option values must be strings/);
  });
});

describe("setting a value", () => {
  const write = (def: unknown, value: unknown) => {
    serve(def);
    return setCustomFieldValueQuery(
      { definition_id: (def as any).id, entity_id: 5, value },
      ORG,
      mockTx as any,
    );
  };

  it("accepts a current option id and stores it", async () => {
    await write(scoredDef, "opt_00000002");
    const insert = mockQuery.mock.calls.find((c) =>
      flat(c[0]).startsWith("INSERT INTO custom_field_values"),
    )!;
    expect((insert[1] as any).replacements.value).toBe(JSON.stringify("opt_00000002"));
  });

  it.each([
    ["a label", "Medium"],
    ["an unknown id", "opt_ffffffff"],
    ["a number", 2],
  ])("rejects %s", async (_name, value) => {
    await expect(write(scoredDef, value)).rejects.toThrow(/allowed options/);
  });

  it("reads the definition FOR SHARE inside the caller's transaction", async () => {
    await write(scoredDef, "opt_00000001");
    const read = mockQuery.mock.calls.find((c) =>
      flat(c[0]).startsWith("SELECT * FROM custom_field_definitions"),
    )!;
    expect(flat(read[0])).toMatch(/FOR SHARE$/);
    expect((read[1] as any).transaction).toBe(mockTx);
  });

  it("still validates select and multiselect values by label (regression)", async () => {
    await expect(write(selectDef, "EU")).resolves.toBeDefined();
    await expect(write(selectDef, "XX")).rejects.toThrow(/allowed options/);
    await expect(write(multiDef, ["a", "b"])).resolves.toBeDefined();
    await expect(write(multiDef, ["c"])).rejects.toThrow(/allowed options/);
  });
});
