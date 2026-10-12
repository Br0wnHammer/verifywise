import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../database/db", () => ({ sequelize: { query: jest.fn() } }));

import { sequelize } from "../../database/db";
import { GENERIC_FORMATTERS, getEntityConfig } from "../../config/changeHistory.config";
import { recordEntityCreation } from "../changeHistory.base.utils";

const mockQuery = sequelize.query as jest.MockedFunction<any>;
const formatters = getEntityConfig("incident").fieldFormatters!;
const tx = { id: "tx" } as any;

describe("incident change-history formatters are tenant-scoped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["project_id", "projects", "Use case"],
    ["model_inventory_id", "model_inventories", "Model"],
  ])(
    "%s resolves a name only within the organization, on the update transaction",
    async (field, table, label) => {
      mockQuery.mockResolvedValueOnce([{ name: "Fraud model" }]);

      await expect(formatters[field](5, { organizationId: 1, transaction: tx })).resolves.toBe(
        "Fraud model",
      );
      const [sql, options] = mockQuery.mock.calls[0];
      expect(sql).toContain(`FROM ${table}`);
      expect(sql).toContain("organization_id = :organizationId");
      expect(options).toMatchObject({
        replacements: { id: 5, organizationId: 1 },
        transaction: tx,
      });

      // Another organization's row is not found → id fallback, no name leaked.
      mockQuery.mockResolvedValueOnce([]);
      await expect(formatters[field](6, { organizationId: 1 })).resolves.toBe(`${label} #6`);
    },
  );

  it.each([["project_id"], ["model_inventory_id"]])(
    "%s does not query at all without an organization",
    async (field) => {
      await expect(formatters[field](5)).resolves.toMatch(/ #5$/);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  it("assignee_id uses the user lookup scoped to the organization", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7, name: "Grace", surname: "Hopper", email: null }]);

    await expect(formatters.assignee_id("7", { organizationId: 1, transaction: tx })).resolves.toBe(
      "Grace Hopper",
    );
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("organization_id = :organizationId");
    expect(options).toMatchObject({
      replacements: { userId: 7, organizationId: 1 },
      transaction: tx,
    });
  });

  it("the generic user formatter keeps its unscoped lookup when given no organization", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(GENERIC_FORMATTERS.user(7)).resolves.toBe("User #7");
    expect(mockQuery.mock.calls[0][0]).not.toContain("organization_id");
  });

  it("creation history records names, looked up in the organization on the creating transaction", async () => {
    const createTx = { afterCommit: jest.fn() } as any;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users")) {
        return [{ id: 7, name: "Grace", surname: "Hopper", email: null }];
      }
      if (sql.includes("FROM projects")) return [{ name: "Chatbot" }];
      return [[], 0];
    });

    await recordEntityCreation(
      "incident",
      42,
      5,
      1,
      { status: "Open", assignee_id: 7, project_id: 3 },
      createTx,
    );

    const lookups = mockQuery.mock.calls.filter(([sql]: [string]) => !sql.startsWith("INSERT"));
    expect(lookups).toHaveLength(2);
    for (const [sql, options] of lookups) {
      expect(sql).toContain("organization_id = :organizationId");
      expect(options).toMatchObject({ replacements: { organizationId: 1 }, transaction: createTx });
    }
    const inserted = mockQuery.mock.calls
      .filter(([sql]: [string]) => sql.startsWith("INSERT"))
      .map(([, options]: [string, any]) => [
        options.replacements.field_name,
        options.replacements.new_value,
      ]);
    expect(inserted).toEqual(
      expect.arrayContaining([
        ["Owner", "Grace Hopper"],
        ["Linked use case", "Chatbot"],
        ["Status", "Open"],
      ]),
    );
  });
});
