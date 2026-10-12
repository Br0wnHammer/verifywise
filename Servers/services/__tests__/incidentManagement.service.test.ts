import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const afterCommitCallbacks: Array<() => void> = [];
const mockTransaction = {
  commit: jest.fn(),
  rollback: jest.fn(),
  afterCommit: jest.fn((cb: () => void) => afterCommitCallbacks.push(cb)),
};

jest.mock("../../database/db", () => ({
  sequelize: { transaction: jest.fn(async () => mockTransaction), query: jest.fn() },
}));
// Real diff; the queries are stubbed.
jest.mock("../../utils/incidentManagement.utils", () => ({
  ...(jest.requireActual("../../utils/incidentManagement.utils") as object),
  getIncidentByIdQuery: jest.fn(),
  updateIncidentByIdQuery: jest.fn(),
  validateIncidentReferences: jest.fn(async () => []),
  enqueueIncidentUpdatedAutomations: jest.fn(async () => undefined),
}));
jest.mock("../../services/automations/automationProducer", () => ({
  enqueueAutomationAction: jest.fn(),
}));
// Real history formatting; only the history write is stubbed.
jest.mock("../../utils/changeHistory.base.utils", () => ({
  ...(jest.requireActual("../../utils/changeHistory.base.utils") as object),
  recordMultipleFieldChanges: jest.fn(),
}));

import {
  INCIDENT_CHANGED_MESSAGE,
  IncidentUpdateValidationError,
  updateIncident,
} from "../incidentManagement.service";
import { sequelize } from "../../database/db";
import {
  enqueueIncidentUpdatedAutomations,
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
  validateIncidentReferences,
} from "../../utils/incidentManagement.utils";
import { recordMultipleFieldChanges } from "../../utils/changeHistory.base.utils";
import { ConflictException } from "../../domain.layer/exceptions/custom.exception";
import {
  AIIncidentManagementApprovalStatus as Approval,
  AIIncidentManagementStatus as Status,
} from "../../domain.layer/enums/ai-incident-management.enum";
import { drawerPayload, storedIncident, STORED_UPDATED_AT } from "./helpers/incidentFixtures";

const mockGet = getIncidentByIdQuery as jest.MockedFunction<any>;
const mockUpdate = updateIncidentByIdQuery as jest.MockedFunction<any>;
const mockRefs = validateIncidentReferences as jest.MockedFunction<any>;
const mockEnqueue = enqueueIncidentUpdatedAutomations as jest.MockedFunction<any>;
const mockRecord = recordMultipleFieldChanges as jest.MockedFunction<any>;

describe("updateIncident (shared incident write path)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    afterCommitCallbacks.length = 0;
    mockGet.mockImplementation(async () => storedIncident());
    mockUpdate.mockImplementation(async (_id: number, changed: any) => ({ id: 42, ...changed }));
    mockRefs.mockResolvedValue([]);
  });

  it("loads the incident once, locked FOR UPDATE in its own transaction", async () => {
    await updateIncident(1, 42, { status: Status.INVESTIGATING }, 7);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(42, 1, { transaction: mockTransaction, lock: true });
    expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
  });

  it("resets the approval when replaying the edit drawer's reopen payload", async () => {
    const body = drawerPayload(storedIncident().dataValues, Status.INVESTIGATING);

    await updateIncident(1, 42, body, 7);

    // Only the reopen and the reset are written; the drawer's unchanged
    // fields (dates as YYYY-MM-DD, '' for empty text) are not.
    expect(mockUpdate.mock.calls[0][1]).toEqual({
      status: Status.INVESTIGATING,
      approval_status: Approval.PENDING,
      approved_by: null,
      approval_date: null,
      approval_notes: null,
    });
  });

  it("records history for exactly the columns it writes", async () => {
    await updateIncident(1, 42, { status: Status.INVESTIGATING, assignee_id: 8 }, 7);

    const written = Object.keys(mockUpdate.mock.calls[0][1]);
    const [entity, incidentId, userId, orgId, changes, tx, system] = mockRecord.mock.calls[0];
    expect([entity, incidentId, userId, orgId, tx, system]).toEqual([
      "incident",
      42,
      7,
      1,
      mockTransaction,
      false,
    ]);
    expect(changes).toHaveLength(written.length);
    expect(changes).toEqual(
      expect.arrayContaining([
        { fieldName: "Status", oldValue: "Closed", newValue: "Investigating" },
        { fieldName: "Approval status", oldValue: "Approved", newValue: "Pending" },
        { fieldName: "Approved by", oldValue: "Jane Doe", newValue: "-" },
        { fieldName: "Approval date", oldValue: "2026-10-01", newValue: "-" },
        { fieldName: "Approval notes", oldValue: "Closure signed off", newValue: "-" },
        // FK changes are tracked and shown by name (user lookup; mocked DB → fallback).
        { fieldName: "Owner", oldValue: "User #7", newValue: "User #8" },
      ]),
    );
  });

  it("does nothing for a no-op update: no write, no history, no automations", async () => {
    const body = drawerPayload(storedIncident().dataValues, Status.CLOSED);

    const result = await updateIncident(1, 42, body, 7);

    expect(result).toEqual(expect.objectContaining({ id: 42, updated_at: STORED_UPDATED_AT }));
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockTransaction.afterCommit).not.toHaveBeenCalled();
    expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
  });

  it("enqueues automations only after commit", async () => {
    await updateIncident(1, 42, { status: Status.OPEN }, 7);

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(afterCommitCallbacks).toHaveLength(1);
    afterCommitCallbacks[0]();
    expect(mockEnqueue).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ id: 42 }),
      expect.objectContaining({ status: Status.OPEN }),
    );
  });

  describe("optimistic concurrency (expectedUpdatedAt)", () => {
    it("accepts the updated_at the editor loaded", async () => {
      await updateIncident(1, 42, { status: Status.OPEN }, 7, {
        expectedUpdatedAt: STORED_UPDATED_AT.toISOString(),
      });
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("refuses a stale updated_at with a ConflictException and writes nothing", async () => {
      const attempt = updateIncident(1, 42, { status: Status.OPEN }, 7, {
        expectedUpdatedAt: "2026-10-10T12:00:00.000Z",
      });

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(INCIDENT_CHANGED_MESSAGE);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockTransaction.rollback).toHaveBeenCalled();
    });
  });

  it("validates references against the locked row inside the transaction", async () => {
    mockRefs.mockResolvedValue(["assignee_id"]);

    const attempt = updateIncident(1, 42, { assignee_id: 999 }, 7);

    await expect(attempt).rejects.toBeInstanceOf(IncidentUpdateValidationError);
    await expect(attempt).rejects.toMatchObject({
      errors: [
        {
          field: "assignee_id",
          message: "assignee_id does not reference an entity in your organization",
          code: "INVALID_REFERENCE",
        },
      ],
    });
    // Unchanged FKs come from the locked row.
    expect(mockRefs).toHaveBeenCalledWith(
      { model_inventory_id: null, project_id: 3, assignee_id: 999 },
      1,
      mockTransaction,
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("records a system change with no actor when changedBySystem is set", async () => {
    await updateIncident(1, 42, { status: Status.OPEN }, null, { changedBySystem: true });

    const [, , userId, , , , system] = mockRecord.mock.calls[0];
    expect(userId).toBeNull();
    expect(system).toBe(true);
  });

  it("uses the caller's transaction without committing or rolling it back", async () => {
    const callerTx = { commit: jest.fn(), rollback: jest.fn(), afterCommit: jest.fn() };
    await updateIncident(1, 42, { status: Status.OPEN }, 7, { transaction: callerTx as any });

    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith(42, 1, { transaction: callerTx, lock: true });
    expect(callerTx.afterCommit).toHaveBeenCalledTimes(1);
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
