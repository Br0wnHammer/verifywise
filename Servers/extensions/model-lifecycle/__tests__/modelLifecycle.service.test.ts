/**
 * Model lifecycle item change history (issue #4915).
 *
 * updateItem snapshots the patched fields before the UPDATE and records an
 * 'updated' row in model_lifecycle_change_history with JSONB old/new
 * snapshots and the acting user.
 */

jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn() },
}));

import { sequelize } from "../../../database/db";
import { updateItem } from "../modelLifecycle.service";

const mockQuery = sequelize.query as jest.Mock;

beforeEach(() => mockQuery.mockReset());

describe("updateItem change history", () => {
  it("records an updated change with old and new snapshots and the actor", async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          name: "Old name",
          description: "Desc",
          item_type: "gate",
          is_required: true,
          display_order: 1,
          config: null,
          is_active: true,
        },
      ])
      .mockResolvedValueOnce([[{ id: 5, name: "New name" }], 1]);

    const result = await updateItem(1, 5, { name: "New name" }, 7);

    expect(result).toEqual({ id: 5, name: "New name" });
    const insert = mockQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO model_lifecycle_change_history"),
    );
    expect(insert).toBeDefined();
    expect(insert[1].replacements).toEqual(
      expect.objectContaining({
        organizationId: 1,
        itemId: 5,
        changeType: "updated",
        changedBy: 7,
        oldValue: JSON.stringify({ name: "Old name" }),
        newValue: JSON.stringify({ name: "New name" }),
      }),
    );
  });

  it("keeps structured config values as objects in the snapshot", async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          name: "N",
          description: null,
          item_type: "gate",
          is_required: false,
          display_order: 2,
          config: { Approver: "Admin" },
          is_active: true,
        },
      ])
      .mockResolvedValueOnce([[{ id: 6 }], 1]);

    await updateItem(1, 6, { config: { Approver: "Reviewer" } }, null);

    const insert = mockQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO model_lifecycle_change_history"),
    );
    expect(insert[1].replacements.oldValue).toBe(JSON.stringify({ config: { Approver: "Admin" } }));
    expect(insert[1].replacements.newValue).toBe(
      JSON.stringify({ config: { Approver: "Reviewer" } }),
    );
    expect(insert[1].replacements.changedBy).toBeNull();
  });

  it("records nothing when there are no fields to update", async () => {
    const result = await updateItem(1, 5, {}, 7);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
