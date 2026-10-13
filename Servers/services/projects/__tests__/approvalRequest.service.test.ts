/**
 * createUseCaseApprovalRequest guards (issue #4906).
 *
 * A soft-deleted workflow (is_active = false) or one defined for another
 * entity type must never start a use-case approval request: both are rejected
 * with a ValidationException, which the controllers map to 400.
 */

import { ValidationException } from "../../../domain.layer/exceptions/custom.exception";

jest.mock("../../../utils/approvalWorkflow.utils", () => ({
  getApprovalWorkflowByIdQuery: jest.fn(),
}));

jest.mock("../../../utils/approvalRequest.utils", () => ({
  createApprovalRequestQuery: jest.fn(),
  tryAutoApproveRequestQuery: jest.fn(),
}));

import { getApprovalWorkflowByIdQuery } from "../../../utils/approvalWorkflow.utils";
import {
  createApprovalRequestQuery,
  tryAutoApproveRequestQuery,
} from "../../../utils/approvalRequest.utils";
import { createUseCaseApprovalRequest } from "../approvalRequest.service";

const mockGetWorkflow = getApprovalWorkflowByIdQuery as jest.MockedFunction<
  typeof getApprovalWorkflowByIdQuery
>;
const mockCreateRequest = createApprovalRequestQuery as jest.MockedFunction<
  typeof createApprovalRequestQuery
>;
const mockAutoApprove = tryAutoApproveRequestQuery as jest.MockedFunction<
  typeof tryAutoApproveRequestQuery
>;

const project = {
  id: 11,
  project_title: "Use case A",
  owner: 3,
  ai_risk_classification: "High risk",
  approval_workflow_id: 5,
} as any;

const transaction = {} as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockAutoApprove.mockResolvedValue({ autoApproved: false } as any);
});

describe("createUseCaseApprovalRequest workflow guards", () => {
  it("rejects an inactive (soft-deleted) workflow with ValidationException", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: 5,
      is_active: false,
      entity_type: "use_case",
      steps: [{ id: 1 }],
    } as any);

    await expect(
      createUseCaseApprovalRequest(project, 3, 1, transaction),
    ).rejects.toThrow(ValidationException);
    await expect(
      createUseCaseApprovalRequest(project, 3, 1, transaction),
    ).rejects.toThrow(/deactivated/);
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it("rejects a workflow defined for another entity type", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: 5,
      is_active: true,
      entity_type: "vendor",
      steps: [{ id: 1 }],
    } as any);

    await expect(
      createUseCaseApprovalRequest(project, 3, 1, transaction),
    ).rejects.toThrow(ValidationException);
    await expect(
      createUseCaseApprovalRequest(project, 3, 1, transaction),
    ).rejects.toThrow(/not defined for use cases/);
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it("creates the request for an active use-case workflow", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: 5,
      is_active: true,
      entity_type: "use_case",
      steps: [{ id: 1 }],
    } as any);
    mockCreateRequest.mockResolvedValue({
      id: 44,
      setDataValue: jest.fn(),
    } as any);

    const result = await createUseCaseApprovalRequest(project, 3, 1, transaction);

    expect(mockCreateRequest).toHaveBeenCalledTimes(1);
    expect(result?.request.id).toBe(44);
    expect(result?.autoApproved).toBe(false);
  });

  it("still returns null when no workflow is attached", async () => {
    const result = await createUseCaseApprovalRequest(
      { ...project, approval_workflow_id: null } as any,
      3,
      1,
      transaction,
    );
    expect(result).toBeNull();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});
