import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Request, Response } from "express";

const mockTransaction = { commit: jest.fn(), rollback: jest.fn() };

jest.mock("../../database/db", () => ({
  sequelize: { transaction: jest.fn(async () => mockTransaction), query: jest.fn() },
}));
jest.mock("../../utils/incidentManagement.utils", () => ({
  getAllIncidentsQuery: jest.fn(),
  getIncidentByIdQuery: jest.fn(),
  createNewIncidentQuery: jest.fn(),
  updateIncidentByIdQuery: jest.fn(),
  deleteIncidentByIdQuery: jest.fn(),
  archiveIncidentByIdQuery: jest.fn(),
  validateIncidentReferences: jest.fn(async () => []),
}));
// Real change tracking; only the history write is stubbed.
jest.mock("../../utils/incidentChangeHistory.utils", () => ({
  ...(jest.requireActual("../../utils/incidentChangeHistory.utils") as object),
  recordIncidentCreation: jest.fn(),
  recordMultipleFieldChanges: jest.fn(),
}));
jest.mock("../../services/workflows/triggers", () => ({ triggerIncidentResponse: jest.fn() }));
jest.mock("../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../../utils/i18n.utils", () => ({
  translateError: jest.fn((_req, err) => (err as Error).message),
}));

import { updateIncidentById } from "../incident-management.ctrl";
import {
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
} from "../../utils/incidentManagement.utils";
import { recordMultipleFieldChanges } from "../../utils/incidentChangeHistory.utils";

const mockGet = getIncidentByIdQuery as jest.MockedFunction<any>;
const mockUpdate = updateIncidentByIdQuery as jest.MockedFunction<any>;
const mockRecord = recordMultipleFieldChanges as jest.MockedFunction<any>;

/** A stored Closed incident whose closure was approved. */
function closedApprovedIncident() {
  const incident: Record<string, any> = {
    id: 42,
    status: "Closed",
    severity: "Serious",
    description: "Model produced unsafe output",
    approval_status: "Approved",
    approved_by: "Jane Doe",
    approval_date: "2026-10-01T00:00:00.000Z",
    approval_notes: "Closure signed off",
  };
  incident.toSafeJSON = () => {
    const { toSafeJSON: _omit, ...rest } = incident;
    return { ...rest };
  };
  return incident;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res as Response;
}

function mockReq(body: Record<string, unknown>) {
  return {
    params: { id: "42" },
    body,
    organizationId: 1,
    userId: 7,
    t: (key: string) => key,
  } as unknown as Request;
}

describe("updateIncidentById — reopening a closed incident", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation(async () => closedApprovedIncident());
    mockUpdate.mockImplementation(async (_id: number, incident: any) => ({
      toSafeJSON: () => ({ ...incident }),
    }));
  });

  it("moves Closed → Investigating, resets the approval and records both in history", async () => {
    const res = mockRes();
    // The edit form sends the whole record back, approval fields unchanged.
    await updateIncidentById(
      mockReq({
        status: "Investigating",
        approval_status: "Approved",
        approved_by: "Jane Doe",
        approval_date: "2026-10-01T00:00:00.000Z",
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.status).toBe("Investigating");
    expect(saved.approval_status).toBe("Pending");
    expect(saved.approved_by).toBeNull();
    expect(saved.approval_date).toBeNull();
    expect(saved.approval_notes).toBe("Closure signed off");

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [incidentId, userId, orgId, changes] = mockRecord.mock.calls[0];
    expect([incidentId, userId, orgId]).toEqual([42, 7, 1]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldName: "Status", oldValue: "Closed", newValue: "Investigating" },
        { fieldName: "Approval status", oldValue: "Approved", newValue: "Pending" },
        { fieldName: "Approved by", oldValue: "Jane Doe", newValue: "-" },
        expect.objectContaining({ fieldName: "Approval date", newValue: "-" }),
      ]),
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it("keeps an approval status the caller changed in the same update", async () => {
    const res = mockRes();
    await updateIncidentById(mockReq({ status: "Open", approval_status: "Not Required" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.status).toBe("Open");
    expect(saved.approval_status).toBe("Not Required");
    expect(saved.approved_by).toBe("Jane Doe");
  });
});
