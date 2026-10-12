jest.mock("../jiraAssets.service", () => {
  class JiraConfigValidationError extends Error {}
  class JiraNotConfiguredError extends Error {}
  class JiraSyncInProgressError extends Error {}
  return {
    JiraConfigValidationError,
    JiraNotConfiguredError,
    JiraSyncInProgressError,
    startManualSync: jest.fn(),
    importObjects: jest.fn(),
    updateSelection: jest.fn(),
    loadFullConfig: jest.fn(),
    clientFromConfig: jest.fn(),
  };
});
jest.mock("../jira.client", () => {
  class JiraUpstreamError extends Error {}
  return { JiraUpstreamError };
});
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../../../utils/i18n.utils", () => ({
  translateError: jest.fn(() => "Something went wrong"),
}));

import { getObjects, patchSelection, postImport, postSync } from "../jiraAssets.ctrl";
import {
  clientFromConfig,
  importObjects,
  JiraConfigValidationError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  loadFullConfig,
  startManualSync,
  updateSelection,
} from "../jiraAssets.service";
import { JiraUpstreamError } from "../jira.client";

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const req: any = { organizationId: 5, userId: 8, body: {}, params: {}, t: (s: string) => s };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /sync (Sync now)", () => {
  it("returns 202 with the queued run's id", async () => {
    (startManualSync as jest.Mock).mockResolvedValue({ historyId: 77 });
    const res = mockRes();

    await postSync(req, res);

    expect(startManualSync).toHaveBeenCalledWith(5, 8);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ message: "Accepted", data: { historyId: 77 } });
  });

  it.each([
    [new JiraNotConfiguredError("Jira Assets is not configured."), 404, "data"],
    [new JiraConfigValidationError("Select an object type before syncing"), 400, "data"],
    [new JiraSyncInProgressError("A Jira Assets sync is already running"), 409, "data"],
    [new JiraUpstreamError("Jira returned 401: bad creds"), 502, "error"],
  ])("maps %p to %i with the reason in `%s`", async (err, status, field) => {
    (startManualSync as jest.Mock).mockRejectedValue(err);
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json.mock.calls[0][0][field]).toBe((err as Error).message);
  });

  it("hides unexpected errors behind a 500", async () => {
    (startManualSync as jest.Mock).mockRejectedValue(new Error("pool exhausted"));
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: "Internal Server Error",
      error: "Something went wrong",
    });
  });
});

describe("POST /import", () => {
  it("returns 502 with Jira's reason when Jira fails", async () => {
    (importObjects as jest.Mock).mockRejectedValue(new JiraUpstreamError("Jira returned 500: x"));
    const res = mockRes();

    await postImport({ ...req, body: { object_ids: ["1"] } }, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      message: "Bad Gateway",
      error: "Jira returned 500: x",
    });
  });

  it("returns 409 while a sync is running", async () => {
    (importObjects as jest.Mock).mockRejectedValue(new JiraSyncInProgressError("running"));
    const res = mockRes();

    await postImport({ ...req, body: { object_ids: ["1"] } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe("PATCH /config/selection", () => {
  it("passes only the body through and returns the saved selection", async () => {
    (updateSelection as jest.Mock).mockResolvedValue({
      selected_schema_id: "3",
      selected_object_type_id: "42",
    });
    const res = mockRes();

    await patchSelection({ ...req, body: { selected_object_type_id: "42" } }, res);

    expect(updateSelection).toHaveBeenCalledWith(5, 8, { selected_object_type_id: "42" });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("GET /object-types/:id/objects (import picker)", () => {
  it("uses the bounded single-page call, not the full walk", async () => {
    const getObjectsPage = jest.fn(async () => []);
    const getAllObjects = jest.fn();
    (loadFullConfig as jest.Mock).mockResolvedValue({
      jira_base_url: "https://x",
      workspace_id: "w",
      email: "e",
    });
    (clientFromConfig as jest.Mock).mockReturnValue({ getObjectsPage, getAllObjects });
    const res = mockRes();

    await getObjects({ ...req, params: { objectTypeId: "42" } }, res);

    expect(getObjectsPage).toHaveBeenCalledWith("42");
    expect(getAllObjects).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
