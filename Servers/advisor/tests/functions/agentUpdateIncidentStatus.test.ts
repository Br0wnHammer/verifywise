import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockTransaction = { commit: jest.fn(), rollback: jest.fn() };

jest.mock("../../../database/db", () => ({
  sequelize: { transaction: jest.fn(async () => mockTransaction), query: jest.fn() },
}));
jest.mock("../../approval/approvalGateway", () => ({ submitForApproval: jest.fn() }));
jest.mock("../../../utils/incidentManagement.utils", () => ({
  getAllIncidentsQuery: jest.fn(),
  getIncidentByIdQuery: jest.fn(),
  createNewIncidentQuery: jest.fn(),
  updateIncidentByIdQuery: jest.fn(),
  deleteIncidentByIdQuery: jest.fn(),
  archiveIncidentByIdQuery: jest.fn(),
}));
// Real change tracking; only the history write is stubbed.
jest.mock("../../../utils/incidentChangeHistory.utils", () => ({
  ...(jest.requireActual("../../../utils/incidentChangeHistory.utils") as object),
  recordMultipleFieldChanges: jest.fn(),
}));

import { writeToolExecutors } from "../../confirmation/createWriteTool";
import "../../functions/incidentFunctions";
import {
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
} from "../../../utils/incidentManagement.utils";
import { recordMultipleFieldChanges } from "../../../utils/incidentChangeHistory.utils";

const mockGet = getIncidentByIdQuery as jest.MockedFunction<any>;
const mockUpdate = updateIncidentByIdQuery as jest.MockedFunction<any>;
const mockRecord = recordMultipleFieldChanges as jest.MockedFunction<any>;

const execute = (params: Record<string, unknown>) =>
  writeToolExecutors.get("agent_update_incident_status")!(params, 1);

function closedIncident(approval_status: string) {
  const values = {
    id: 42,
    ai_project: "Chatbot",
    status: "Closed",
    approval_status,
    approved_by: "Jane Doe",
    approval_date: "2026-10-01T00:00:00.000Z",
  };
  return { ...values, dataValues: { ...values }, toSafeJSON: () => ({ ...values }) };
}

describe("agent_update_incident_status — reopening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockImplementation(async (_id: number, incident: any) => incident);
  });

  it("reopens a Closed incident, resets its approval and records the change history", async () => {
    mockGet.mockResolvedValue(closedIncident("Approved"));

    const result = await execute({ incident_id: 42, status: "Investigating", _userId: 5 });

    expect(result).toEqual({ id: 42, ai_project: "Chatbot", status: "Investigating" });
    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved).toMatchObject({
      status: "Investigating",
      approval_status: "Pending",
      approved_by: null,
      approval_date: null,
    });

    const [incidentId, userId, orgId, changes] = mockRecord.mock.calls[0];
    expect([incidentId, userId, orgId]).toEqual([42, 5, 1]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldName: "Status", oldValue: "Closed", newValue: "Investigating" },
        { fieldName: "Approval status", oldValue: "Approved", newValue: "Pending" },
      ]),
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it("leaves a Rejected approval alone and records only the status change", async () => {
    mockGet.mockResolvedValue(closedIncident("Rejected"));

    await execute({ incident_id: 42, status: "Open", _userId: 5 });

    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved).toMatchObject({ status: "Open", approval_status: "Rejected" });
    expect(mockRecord.mock.calls[0][3]).toEqual([
      { fieldName: "Status", oldValue: "Closed", newValue: "Open" },
    ]);
  });
});
