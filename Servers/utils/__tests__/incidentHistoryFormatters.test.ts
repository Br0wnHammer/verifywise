import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// sequelize.transaction({ transaction }, cb) opens a SAVEPOINT on the parent:
// modelled as a child transaction object handed to the callback, which
// rejects (rolling back only the savepoint) when the callback throws.
jest.mock("../../database/db", () => ({
  sequelize: {
    query: jest.fn(),
    transaction: jest.fn(async (options: any, callback: any) =>
      callback({ savepointOf: options?.transaction }),
    ),
  },
}));

import { sequelize } from "../../database/db";
import { GENERIC_FORMATTERS, getEntityConfig } from "../../config/changeHistory.config";
import { recordEntityCreation } from "../changeHistory.base.utils";

const mockQuery = sequelize.query as jest.MockedFunction<any>;
const formatters = getEntityConfig("incident").fieldFormatters!;
const tx = { id: "tx" } as any;

describe("incident change-history formatters are tenant-scoped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
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
        transaction: { savepointOf: tx },
      });
      expect(sequelize.transaction).toHaveBeenCalledWith({ transaction: tx }, expect.any(Function));

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
      transaction: { savepointOf: tx },
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
      expect(options).toMatchObject({
        replacements: { organizationId: 1 },
        transaction: { savepointOf: createTx },
      });
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

  it("a failing lookup on a transaction falls back to the id label inside its savepoint", async () => {
    const tx = { id: "outer" } as any;
    mockQuery.mockRejectedValueOnce(new Error("division by zero"));

    await expect(formatters.project_id(3, { organizationId: 1, transaction: tx })).resolves.toBe(
      "Use case #3",
    );
    // The failing SELECT ran on the savepoint, not on the caller's transaction.
    expect(sequelize.transaction).toHaveBeenCalledWith({ transaction: tx }, expect.any(Function));
    expect(mockQuery.mock.calls[0][1].transaction).toEqual({ savepointOf: tx });
  });

  it("creation history still records every field when a name lookup fails", async () => {
    const createTx = { afterCommit: jest.fn() } as any;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users")) throw new Error("lookup failed");
      return [[], 0];
    });

    await recordEntityCreation("incident", 42, 5, 1, { status: "Open", assignee_id: 7 }, createTx);

    const inserted = mockQuery.mock.calls
      .filter(([sql]: [string]) => sql.startsWith("INSERT"))
      .map(([, options]: [string, any]) => [
        options.replacements.field_name,
        options.replacements.new_value,
        options.transaction,
      ]);
    expect(inserted).toEqual(
      expect.arrayContaining([
        ["Owner", "User #7", createTx],
        ["Status", "Open", createTx],
      ]),
    );
  });
});
