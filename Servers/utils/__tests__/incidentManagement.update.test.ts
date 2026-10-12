import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../database/db", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("../../services/automations/automationProducer", () => ({
  enqueueAutomationAction: jest.fn(),
}));

import { sequelize } from "../../database/db";
import { updateIncidentByIdQuery } from "../incidentManagement.utils";

const mockQuery = sequelize.query as jest.MockedFunction<any>;

/** Stand-in for the row loaded (and locked) by the caller. */
function storedIncident(values: Record<string, unknown>) {
  return { ...values, getDataValue: (key: string) => values[key] } as any;
}

describe("updateIncidentByIdQuery writes only changed columns", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce([[], 0]) // UPDATE
      .mockResolvedValueOnce([{ id: 42 }]) // re-read
      .mockResolvedValueOnce([[], 0]); // automations
  });

  it("skips fields sent with their stored value and normalises '' to null", async () => {
    const existing = storedIncident({
      status: "Closed",
      description: "Unchanged",
      approval_date: new Date("2026-10-01T00:00:00.000Z"),
      project_id: 3,
      approved_by: "Jane Doe",
    });

    await updateIncidentByIdQuery(
      42,
      {
        status: "Investigating",
        description: "Unchanged",
        approval_date: "2026-10-01T00:00:00.000Z",
        project_id: "",
        approved_by: null,
        // Not an updatable column: ignored.
        organization_id: 999,
      } as any,
      1,
      {} as any,
      existing,
    );

    const [sql, { replacements }] = mockQuery.mock.calls[0];
    expect(sql).toContain("updated_at = :updated_at");
    expect(sql).toContain("status = :status");
    expect(sql).toContain("project_id = :project_id");
    expect(sql).toContain("approved_by = :approved_by");
    expect(sql).not.toContain("description =");
    expect(sql).not.toContain("approval_date =");
    expect(sql).not.toContain(":organization_id");
    expect(replacements).toMatchObject({
      status: "Investigating",
      project_id: null,
      approved_by: null,
      organizationId: 1,
      id: 42,
    });
  });
});
