import { describe, it, expect, jest, beforeEach } from "@jest/globals";

process.env.JWT_SECRET = process.env.JWT_SECRET || "intake-routing-settings-test-secret";

jest.mock("../../utils/intakeForm.utils", () => ({
  getIntakeFormByIdQuery: jest.fn<any>(),
  updateIntakeFormQuery: jest.fn<any>(),
  createIntakeFormQuery: jest.fn<any>(),
  getEligibleReviewerIdsQuery: jest.fn<any>(),
  getEligibleReviewersQuery: jest.fn<any>(),
}));
jest.mock("../../services/intakeRouting/routingService", () => ({
  rerouteFormPending: jest.fn<any>().mockResolvedValue(0),
}));
jest.mock("../../utils/project.utils", () => ({ createNewProjectQuery: jest.fn() }));
jest.mock("../../utils/eu.utils", () => ({ createEUFrameworkQuery: jest.fn() }));
jest.mock("../../utils/modelInventory.utils", () => ({ createNewModelInventoryQuery: jest.fn() }));
jest.mock("../../utils/useCaseChangeHistory.utils", () => ({
  recordMultipleFieldChanges: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock("../../services/intakeFormEmail.service", () => ({}));
jest.mock("../../services/intakeScoring/enqueue", () => ({
  enqueueIntakeAssessment: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock("../../services/intakeLLM.service", () => ({
  generateSuggestedQuestions: jest.fn(),
  generateFieldGuidance: jest.fn(),
}));
jest.mock("../../utils/aiTrustCentre.utils", () => ({ getCompanyLogoQuery: jest.fn() }));
jest.mock("../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn(),
  logSuccess: jest.fn<any>().mockResolvedValue(undefined),
  logFailure: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock("../../utils/i18n.utils", () => ({
  translateError: jest.fn((_, err) => (err as Error).message),
}));
jest.mock("../../utils/statusCode.utils", () => ({
  STATUS_CODE: {
    200: (d: any) => ({ message: "OK", data: d }),
    201: (d: any) => ({ message: "Created", data: d }),
    400: (d: any) => ({ message: "Bad Request", data: d }),
    404: (d: any) => ({ message: "Not Found", data: d }),
    500: (d: any) => ({ message: "Internal Server Error", data: d }),
  },
}));
jest.mock("../../database/db", () => ({
  sequelize: {
    transaction: jest.fn<any>().mockResolvedValue({ commit: jest.fn(), rollback: jest.fn() }),
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const ctrl = require("../intakeForm.ctrl") as typeof import("../intakeForm.ctrl");
const intake = require("../../utils/intakeForm.utils");
const { rerouteFormPending } = require("../../services/intakeRouting/routingService");
/* eslint-enable @typescript-eslint/no-require-imports */

const req = (overrides: any = {}) => ({
  userId: 7,
  organizationId: 5,
  headers: {},
  t: (k: string, vars?: Record<string, string | number>) =>
    k.replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? `{${n}}`)),
  params: { id: "1" },
  body: {},
  ...overrides,
});
const res = () => {
  const r: any = {};
  r.status = jest.fn<any>().mockReturnValue(r);
  r.json = jest.fn<any>().mockReturnValue(r);
  return r;
};
const EXISTING = {
  id: 1,
  name: "F",
  entityType: "use_case",
  status: "draft",
  schema: { version: "1.0", fields: [] },
  euAiActRiskStepEnabled: false,
};
const ROUTING = {
  enabled: true,
  seniorReviewerIds: [1],
  standardReviewerIds: [2],
  threshold: 50,
  closeCallMargin: 10,
  secondReviewRate: 10,
};

beforeEach(() => {
  jest.clearAllMocks();
  intake.getIntakeFormByIdQuery.mockResolvedValue(EXISTING);
  intake.updateIntakeFormQuery.mockResolvedValue({ ...EXISTING, routing: ROUTING });
  intake.getEligibleReviewerIdsQuery.mockResolvedValue([1, 2]);
});

describe("updateIntakeForm routing settings", () => {
  it("rejects a reviewer who is not eligible", async () => {
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1]);
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "Reviewers must be users who can review intake submissions",
      }),
    );
    expect(intake.getEligibleReviewerIdsQuery).toHaveBeenCalledWith(5, [1, 2]);
    expect(intake.updateIntakeFormQuery).not.toHaveBeenCalled();
  });

  it("keeps a stored reviewer who is no longer eligible when the body keeps them", async () => {
    intake.getIntakeFormByIdQuery.mockResolvedValue({ ...EXISTING, routing: ROUTING });
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1]);
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(intake.updateIntakeFormQuery).toHaveBeenCalled();
  });

  it("refuses a newly added ineligible reviewer even when others are stored", async () => {
    intake.getIntakeFormByIdQuery.mockResolvedValue({ ...EXISTING, routing: ROUTING });
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1, 2]);
    const r = res();
    await ctrl.updateIntakeForm(
      req({ body: { routing: { ...ROUTING, standardReviewerIds: [2, 9] } } }) as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "Reviewers must be users who can review intake submissions",
      }),
    );
  });

  it("refuses to change an enabled lane to one with nobody eligible", async () => {
    intake.getIntakeFormByIdQuery.mockResolvedValue({ ...EXISTING, routing: ROUTING });
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1]);
    const r = res();
    await ctrl.updateIntakeForm(
      req({
        body: { routing: { ...ROUTING, seniorReviewerIds: [1], standardReviewerIds: [] } },
      }) as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
  });

  it("refuses to turn routing on when a lane has nobody eligible", async () => {
    intake.getIntakeFormByIdQuery.mockResolvedValue({
      ...EXISTING,
      routing: { ...ROUTING, enabled: false },
    });
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1]);
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "Each reviewer list needs at least one user who can currently review intake submissions",
      }),
    );
  });

  it("lets an untouched enabled form with an emptied lane save", async () => {
    intake.getIntakeFormByIdQuery.mockResolvedValue({ ...EXISTING, routing: ROUTING });
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([1]);
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { name: "X", routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("returns the validator message for an invalid threshold", async () => {
    const r = res();
    await ctrl.updateIntakeForm(
      req({ body: { routing: { ...ROUTING, threshold: 150 } } }) as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: "threshold must be a whole number from 1 to 99" }),
    );
    expect(intake.updateIntakeFormQuery).not.toHaveBeenCalled();
  });

  it("saves valid settings and re-routes pending submissions once", async () => {
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(intake.updateIntakeFormQuery.mock.calls[0][1].routing).toEqual(ROUTING);
    expect(rerouteFormPending).toHaveBeenCalledTimes(1);
    expect(rerouteFormPending).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 5);
  });

  it("still answers 200 when the re-route fails after the save", async () => {
    rerouteFormPending.mockRejectedValueOnce(new Error("boom"));
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { routing: ROUTING } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("leaves routing unchanged when the body omits it", async () => {
    const r = res();
    await ctrl.updateIntakeForm(req({ body: { name: "Renamed" } }) as any, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(intake.updateIntakeFormQuery.mock.calls[0][1].routing).toBeUndefined();
    expect(intake.getEligibleReviewerIdsQuery).not.toHaveBeenCalled();
    expect(rerouteFormPending).not.toHaveBeenCalled();
  });
});

describe("createIntakeForm routing settings", () => {
  it("rejects an ineligible reviewer", async () => {
    intake.getEligibleReviewerIdsQuery.mockResolvedValue([]);
    const r = res();
    await ctrl.createIntakeForm(
      req({ params: {}, body: { name: "F", entityType: "use_case", routing: ROUTING } }) as any,
      r,
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(intake.createIntakeFormQuery).not.toHaveBeenCalled();
  });
});

describe("getEligibleReviewers", () => {
  it("lists the reviewers of the caller's organisation", async () => {
    const rows = [{ id: 1, name: "A", surname: "B", email: "a@b.co" }];
    intake.getEligibleReviewersQuery.mockResolvedValue(rows);
    const r = res();
    await ctrl.getEligibleReviewers(req() as any, r);
    expect(intake.getEligibleReviewersQuery).toHaveBeenCalledWith(5);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(rows);
  });
});
