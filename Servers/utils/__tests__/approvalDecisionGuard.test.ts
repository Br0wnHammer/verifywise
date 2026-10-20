/**
 * Unit tests for who may decide an approval step (processApprovalQuery) and
 * which requests count as waiting on a user (getPendingApprovalsQuery).
 * sequelize.query is mocked, so these assert the guard and the SQL shape,
 * not Postgres behaviour.
 */

jest.mock("../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../../advisor/aiActions", () => ({ executeAiAction: jest.fn() }));
jest.mock("../logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));

import { sequelize } from "../../database/db";
import { getPendingApprovalsQuery, processApprovalQuery } from "../approvalRequest.utils";
import {
  ApprovalRequestStatus,
  ApprovalResult,
} from "../../domain.layer/enums/approval-workflow.enum";
import {
  ForbiddenException,
  ValidationException,
} from "../../domain.layer/exceptions/custom.exception";

const mockQuery = sequelize.query as unknown as jest.Mock;
const transaction = {} as any;

const queueRequestAndStep = (
  myApproval: { approval_result: string } | undefined,
  votedOnEarlierStep = false,
) => {
  mockQuery
    .mockResolvedValueOnce([{ id: 7, status: ApprovalRequestStatus.PENDING, current_step: 1 }])
    .mockResolvedValueOnce([{ id: 70 }])
    .mockResolvedValueOnce(myApproval ? [myApproval] : []);
  if (!myApproval) {
    mockQuery.mockResolvedValueOnce(votedOnEarlierStep ? [{ "?column?": 1 }] : []);
  }
};

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));

describe("processApprovalQuery decision guard", () => {
  beforeEach(() => mockQuery.mockReset());

  it.each([ApprovalResult.APPROVED, ApprovalResult.REJECTED])(
    "refuses a %s from a user who is not an approver on the current step",
    async (result) => {
      queueRequestAndStep(undefined);

      await expect(
        processApprovalQuery(7, 99, result, undefined, 1, transaction),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Nothing was written: no vote, no step or request status change.
      expect(sqlCalls().some((sql) => /^\s*UPDATE/i.test(sql))).toBe(false);
    },
  );

  it.each([ApprovalResult.APPROVED, ApprovalResult.REJECTED])(
    "refuses a second decision from an approver who already responded (%s)",
    async (result) => {
      queueRequestAndStep({ approval_result: ApprovalResult.APPROVED });

      await expect(
        processApprovalQuery(7, 5, result, undefined, 1, transaction),
      ).rejects.toBeInstanceOf(ValidationException);

      expect(sqlCalls().some((sql) => /^\s*UPDATE/i.test(sql))).toBe(false);
    },
  );

  it("treats a retry after the user's vote moved the request on as a repeat, not a 403", async () => {
    queueRequestAndStep(undefined, true);

    await expect(
      processApprovalQuery(7, 5, ApprovalResult.APPROVED, undefined, 1, transaction),
    ).rejects.toBeInstanceOf(ValidationException);

    const [sql, options] = mockQuery.mock.calls[3];
    expect(sql).toMatch(/ars\.request_id = :requestId/);
    expect(options.replacements).toEqual({
      organizationId: 1,
      requestId: 7,
      userId: 5,
      pending: ApprovalResult.PENDING,
    });
    expect(sqlCalls().some((s) => /^\s*UPDATE/i.test(s))).toBe(false);
  });

  it("locks the request row first so concurrent decisions run one at a time", async () => {
    queueRequestAndStep(undefined);

    await expect(
      processApprovalQuery(7, 99, ApprovalResult.APPROVED, undefined, 1, transaction),
    ).rejects.toThrow();

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM approval_requests[\s\S]*FOR UPDATE/);
    expect(options.replacements).toEqual({ organizationId: 1, requestId: 7 });
    expect(options.transaction).toBe(transaction);
  });

  it("scopes the approver lookup to the org, step and user", async () => {
    queueRequestAndStep(undefined);

    await expect(
      processApprovalQuery(7, 99, ApprovalResult.APPROVED, undefined, 1, transaction),
    ).rejects.toThrow();

    const [, options] = mockQuery.mock.calls[2];
    expect(options.replacements).toEqual({ organizationId: 1, requestStepId: 70, userId: 99 });
    expect(options.transaction).toBe(transaction);
  });

  it("records the vote when the approver is still pending", async () => {
    queueRequestAndStep({ approval_result: ApprovalResult.PENDING });
    // Any later query: return an empty result so the function can run on.
    mockQuery.mockResolvedValue([]);

    await processApprovalQuery(7, 5, ApprovalResult.APPROVED, "ok", 1, transaction).catch(
      () => undefined,
    );

    const update = mockQuery.mock.calls.find((call) =>
      /UPDATE approval_request_step_approvals/.test(String(call[0])),
    );
    expect(update).toBeDefined();
    expect(update![1].replacements).toMatchObject({
      userId: 5,
      approvalResult: ApprovalResult.APPROVED,
      comments: "ok",
    });
  });
});

describe("getPendingApprovalsQuery", () => {
  beforeEach(() => mockQuery.mockReset());

  it("only lists requests the user has not responded to yet", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getPendingApprovalsQuery(5, 1);

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/arsa\.approval_result = :pendingResult/);
    expect(options.replacements.pendingResult).toBe(ApprovalResult.PENDING);
  });
});
