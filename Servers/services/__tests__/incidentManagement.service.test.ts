import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockTransaction = { commit: jest.fn(), rollback: jest.fn() };

jest.mock("../../database/db", () => ({
  sequelize: { transaction: jest.fn(async () => mockTransaction), query: jest.fn() },
}));
jest.mock("../../utils/incidentManagement.utils", () => ({
  getIncidentByIdQuery: jest.fn(),
  updateIncidentByIdQuery: jest.fn(),
}));
// Real change tracking; only the history write is stubbed.
jest.mock("../../utils/changeHistory.base.utils", () => ({
  ...(jest.requireActual("../../utils/changeHistory.base.utils") as object),
  recordMultipleFieldChanges: jest.fn(),
}));

import { updateIncident } from "../incidentManagement.service";
import { sequelize } from "../../database/db";
import {
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
} from "../../utils/incidentManagement.utils";
import { recordMultipleFieldChanges } from "../../utils/changeHistory.base.utils";
import {
  AIIncidentManagementApprovalStatus as Approval,
  AIIncidentManagementStatus as Status,
} from "../../domain.layer/enums/ai-incident-management.enum";

const mockGet = getIncidentByIdQuery as jest.MockedFunction<any>;
const mockUpdate = updateIncidentByIdQuery as jest.MockedFunction<any>;
const mockRecord = recordMultipleFieldChanges as jest.MockedFunction<any>;

function closedApprovedIncident() {
  const values = {
    id: 42,
    ai_project: "Chatbot",
    status: Status.CLOSED,
    approval_status: Approval.APPROVED,
    approved_by: "Jane Doe",
    approval_date: "2026-10-01T00:00:00.000Z",
    approval_notes: "Closure signed off",
  };
  return { ...values, toSafeJSON: () => ({ ...values }) };
}

describe("updateIncident (shared incident write path)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation(async () => closedApprovedIncident());
    mockUpdate.mockImplementation(async (_id: number, changes: any) => ({ id: 42, ...changes }));
  });

  it("loads the incident once, locked FOR UPDATE in its own transaction", async () => {
    await updateIncident(1, 42, { status: Status.INVESTIGATING }, 7);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(42, 1, { transaction: mockTransaction, lock: true });
    // The loaded row is handed to the write so it does not re-read it.
    expect(mockUpdate.mock.calls[0][4]).toEqual(expect.objectContaining({ id: 42 }));
    expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
  });

  it("resets a stale closure approval on reopen and records it in history", async () => {
    await updateIncident(1, 42, { status: Status.INVESTIGATING }, 7);

    expect(mockUpdate.mock.calls[0][1]).toEqual({
      status: Status.INVESTIGATING,
      approval_status: Approval.PENDING,
      approved_by: null,
      approval_date: null,
      approval_notes: null,
    });

    const [entity, incidentId, userId, orgId, changes, tx, system] = mockRecord.mock.calls[0];
    expect([entity, incidentId, userId, orgId, tx, system]).toEqual([
      "incident",
      42,
      7,
      1,
      mockTransaction,
      false,
    ]);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldName: "Status", oldValue: "Closed", newValue: "Investigating" },
        { fieldName: "Approval status", oldValue: "Approved", newValue: "Pending" },
        { fieldName: "Approved by", oldValue: "Jane Doe", newValue: "-" },
        { fieldName: "Approval notes", oldValue: "Closure signed off", newValue: "-" },
        expect.objectContaining({ fieldName: "Approval date", newValue: "-" }),
      ]),
    );
  });

  it("records a system change with no actor when changedBySystem is set", async () => {
    await updateIncident(1, 42, { status: Status.OPEN }, null, { changedBySystem: true });

    const [, , userId, , , , system] = mockRecord.mock.calls[0];
    expect(userId).toBeNull();
    expect(system).toBe(true);
  });

  it("uses the caller's transaction without committing or rolling it back", async () => {
    const callerTx = { commit: jest.fn(), rollback: jest.fn() };
    await updateIncident(1, 42, { status: Status.OPEN }, 7, { transaction: callerTx as any });

    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith(42, 1, { transaction: callerTx, lock: true });
    expect(callerTx.commit).not.toHaveBeenCalled();
    expect(callerTx.rollback).not.toHaveBeenCalled();
  });

  it("returns null and rolls back when the incident does not exist", async () => {
    mockGet.mockResolvedValue(null);

    await expect(updateIncident(1, 99, { status: Status.OPEN }, 7)).resolves.toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
  });

  it("rolls back and rethrows when the write fails", async () => {
    mockUpdate.mockRejectedValue(new Error("db down"));

    await expect(updateIncident(1, 42, { status: Status.OPEN }, 7)).rejects.toThrow("db down");
    expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
