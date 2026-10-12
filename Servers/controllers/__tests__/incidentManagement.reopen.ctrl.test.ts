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
// Real change tracking (through the shared service); only the history write is stubbed.
jest.mock("../../utils/changeHistory.base.utils", () => ({
  ...(jest.requireActual("../../utils/changeHistory.base.utils") as object),
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
import { recordMultipleFieldChanges } from "../../utils/changeHistory.base.utils";

const mockGet = getIncidentByIdQuery as jest.MockedFunction<any>;
const mockUpdate = updateIncidentByIdQuery as jest.MockedFunction<any>;
const mockRecord = recordMultipleFieldChanges as jest.MockedFunction<any>;

/** A stored Closed incident whose closure was approved. */
function closedApprovedIncident() {
  const values = {
    id: 42,
    status: "Closed",
    severity: "Serious",
    description: "Model produced unsafe output",
    approval_status: "Approved",
    approved_by: "Jane Doe",
    approval_date: "2026-10-01T00:00:00.000Z",
    approval_notes: "Closure signed off",
  };
  return { ...values, toSafeJSON: () => ({ ...values }) };
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
    mockUpdate.mockImplementation(async (_id: number, changes: any) => ({
      toSafeJSON: () => ({ id: 42, ...changes }),
    }));
  });

  it("moves Closed → Investigating, resets the approval and records it in history", async () => {
    const res = mockRes();
    // The edit form sends the whole record back, approval fields unchanged.
    await updateIncidentById(
      mockReq({
        status: "Investigating",
        approval_status: "Approved",
        approved_by: "Jane Doe",
        approval_date: "2026-10-01T00:00:00.000Z",
        approval_notes: "Closure signed off",
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      message: "OK",
      data: expect.objectContaining({ id: 42, status: "Investigating" }),
    });
    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved).toMatchObject({
      status: "Investigating",
      approval_status: "Pending",
      approved_by: null,
      approval_date: null,
      approval_notes: null,
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [entity, incidentId, userId, orgId, changes] = mockRecord.mock.calls[0];
    expect([entity, incidentId, userId, orgId]).toEqual(["incident", 42, 7, 1]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldName: "Status", oldValue: "Closed", newValue: "Investigating" },
        { fieldName: "Approval status", oldValue: "Approved", newValue: "Pending" },
        { fieldName: "Approved by", oldValue: "Jane Doe", newValue: "-" },
        { fieldName: "Approval notes", oldValue: "Closure signed off", newValue: "-" },
        expect.objectContaining({ fieldName: "Approval date", newValue: "-" }),
      ]),
    );
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  it("keeps the approver the caller set in the same update", async () => {
    const res = mockRes();
    await updateIncidentById(
      mockReq({ status: "Open", approval_status: "Approved", approved_by: "Sam Lee" }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const saved = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(saved).toEqual({ status: "Open", approval_status: "Approved", approved_by: "Sam Lee" });
  });

  it("returns 404 when the incident does not exist", async () => {
    mockGet.mockResolvedValue(null);
    const res = mockRes();
    await updateIncidentById(mockReq({ status: "Open" }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
