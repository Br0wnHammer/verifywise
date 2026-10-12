import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../database/db", () => ({
  sequelize: {
    transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })),
  },
}));
jest.mock("../../domain.layer/models/incidentManagement/incidemtManagement.model", () => ({
  AIIncidentManagementModel: jest.fn().mockImplementation((data: unknown) => data),
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
jest.mock("../../utils/incidentChangeHistory.utils", () => ({
  recordIncidentCreation: jest.fn(),
  trackIncidentChanges: jest.fn(async () => []),
  recordMultipleFieldChanges: jest.fn(),
}));
jest.mock("../../services/workflows/triggers", () => ({
  triggerIncidentResponse: jest.fn(async () => undefined),
}));
jest.mock("../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  logStructured: jest.fn(),
}));

import { createNewIncident, updateIncidentById } from "../incident-management.ctrl";
import {
  createNewIncidentQuery,
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
} from "../../utils/incidentManagement.utils";
import { assertValidIncidentDescription } from "../../utils/validations/incidentManagementValidation.utils";

const mockCreate = createNewIncidentQuery as unknown as jest.Mock<(...a: any[]) => any>;
const mockUpdate = updateIncidentByIdQuery as unknown as jest.Mock<(...a: any[]) => any>;
const mockGetById = getIncidentByIdQuery as unknown as jest.Mock<(...a: any[]) => any>;

const TOO_LONG = "Description cannot exceed 32,767 characters.";

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const makeReq = (body: Record<string, unknown>, params: Record<string, string> = {}) =>
  ({ body, params, organizationId: 7, userId: 5 }) as any;

/** The standard validation-failure body these handlers return. */
const expectStandard400 = (res: any, message: string, code: string) => {
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({
    message: "Bad Request",
    data: {
      status: "error",
      message,
      errors: [{ field: "description", message: TOO_LONG, code }],
    },
  });
};

describe("incident controller description validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetById.mockResolvedValue({
      id: 42,
      description: "Existing description",
      toSafeJSON: () => ({ id: 42 }),
    });
  });

  it("rejects an over-long description on create up front, without writing", async () => {
    const res = makeRes();
    await createNewIncident(makeReq({ description: "a".repeat(32768) }), res);
    expectStandard400(res, "Incident creation validation failed", "MAX_LENGTH");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns the same shape when the write path throws a ValidationException on create", async () => {
    mockCreate.mockImplementation(async () => assertValidIncidentDescription("a".repeat(32768)));
    const res = makeRes();
    await createNewIncident(makeReq({ description: "A valid description" }), res);
    expectStandard400(res, "Incident creation validation failed", "MAX_LENGTH");
  });

  it("rejects an over-long changed description on update up front, without writing", async () => {
    const res = makeRes();
    await updateIncidentById(makeReq({ description: "a".repeat(32768) }, { id: "42" }), res);
    expectStandard400(res, "Incident update validation failed", "MAX_LENGTH");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns the same shape when the write path throws a ValidationException on update", async () => {
    mockUpdate.mockImplementation(async () => assertValidIncidentDescription("a".repeat(32768)));
    const res = makeRes();
    await updateIncidentById(makeReq({ status: "Closed" }, { id: "42" }), res);
    expectStandard400(res, "Incident update validation failed", "MAX_LENGTH");
  });
});
