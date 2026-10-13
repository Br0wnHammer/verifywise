jest.mock("../jiraAssets.service", () => {
  class JiraConfigValidationError extends Error {}
  class JiraNotConfiguredError extends Error {}
  class JiraSyncInProgressError extends Error {}
  class RunSupersededError extends Error {}
  class JiraUseCaseNotFoundError extends Error {}
  class JiraUseCaseDeleteFailedError extends Error {}
  class JiraImportInterruptedError extends Error {
    constructor(
      public imported: number,
      public skipped: number,
    ) {
      super(`interrupted after ${imported}`);
    }
  }
  return {
    RunSupersededError,
    JiraUseCaseNotFoundError,
    JiraUseCaseDeleteFailedError,
    JiraImportInterruptedError,
    getSyncStatus: jest.fn(),
    JiraConfigValidationError,
    JiraNotConfiguredError,
    JiraSyncInProgressError,
    JIRA_SYNC_IN_PROGRESS_MESSAGE: "A Jira Assets sync is already running for this organization",
    startManualSync: jest.fn(),
    importObjects: jest.fn(),
    updateSelection: jest.fn(),
    removeMissingUseCases: jest.fn(),
    deleteUseCaseByProjectId: jest.fn(),
    JIRA_RUN_CODES: {
      abandoned: "abandoned",
      skipped: "skipped",
      importInterrupted: "import_interrupted",
      removalInterrupted: "removal_interrupted",
    },
    loadFullConfig: jest.fn(),
    clientFromConfig: jest.fn(),
  };
});
jest.mock("../jira.client", () => {
  class JiraUpstreamError extends Error {}
  return { JiraUpstreamError };
});
jest.mock("../../../services/automations/automationProducer", () => {
  class BackgroundJobsUnavailableError extends Error {}
  return { BackgroundJobsUnavailableError, hasPendingJiraAssetsSyncJob: jest.fn() };
});
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn(),
  logSuccess: jest.fn(),
  logFailure: jest.fn(),
}));
jest.mock("../../../utils/i18n.utils", () => ({
  translateError: jest.fn(() => "Something went wrong"),
}));

import { logFailure, logProcessing, logSuccess } from "../../../utils/logger/logHelper";
import {
  deleteUseCaseCtrl,
  getObjects,
  getSyncStatusCtrl,
  patchSelection,
  postImport,
  postSync,
  removeMissingCtrl,
} from "../jiraAssets.ctrl";
import {
  BackgroundJobsUnavailableError,
  hasPendingJiraAssetsSyncJob,
} from "../../../services/automations/automationProducer";
import {
  clientFromConfig,
  deleteUseCaseByProjectId,
  getSyncStatus,
  JiraImportInterruptedError,
  importObjects,
  JiraConfigValidationError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  JiraUseCaseDeleteFailedError,
  JiraUseCaseNotFoundError,
  loadFullConfig,
  removeMissingUseCases,
  RunSupersededError,
  startManualSync,
  updateSelection,
} from "../jiraAssets.service";
import { JiraUpstreamError } from "../jira.client";
import { SyncInProgressError } from "../../sync-engine/errors";

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
  it("returns 202 with the job id and the newest run before it", async () => {
    (startManualSync as jest.Mock).mockResolvedValue({
      jobId: "jira-assets-sync-5",
      previousRunId: 40,
    });
    const res = mockRes();

    await postSync(req, res);

    expect(startManualSync).toHaveBeenCalledWith(5, 8);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      message: "Accepted",
      data: { jobId: "jira-assets-sync-5", previousRunId: 40 },
    });
  });

  it("returns 503 when the queue does not answer", async () => {
    (startManualSync as jest.Mock).mockRejectedValue(
      new BackgroundJobsUnavailableError("Background jobs are unavailable"),
    );
    const res = mockRes();

    await postSync(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      message: "Service Unavailable",
      error: "Background jobs are unavailable",
    });
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
  it("returns 409 with the Jira message when the engine claim is taken", async () => {
    (importObjects as jest.Mock).mockRejectedValue(new SyncInProgressError());
    const res = mockRes();

    await postImport({ ...req, body: { object_ids: ["1"] } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].data).toBe(
      "A Jira Assets sync is already running for this organization",
    );
  });

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

  it("returns 409 with partial counts when the import was interrupted", async () => {
    (importObjects as jest.Mock).mockRejectedValue(new JiraImportInterruptedError(3, 1));
    const res = mockRes();

    await postImport({ ...req, body: { object_ids: ["1"] } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: "Conflict",
      data: {
        message: "interrupted after 3",
        code: "import_interrupted",
        imported: 3,
        skipped: 1,
      },
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
  it("uses the single-page call from startAt and returns hasMore", async () => {
    const getObjectsPage = jest.fn(async () => ({
      objects: [],
      hasMore: true,
      nextStartAt: 2000,
    }));
    const getAllObjects = jest.fn();
    (loadFullConfig as jest.Mock).mockResolvedValue({
      jira_base_url: "https://x",
      workspace_id: "w",
      email: "e",
    });
    (clientFromConfig as jest.Mock).mockReturnValue({ getObjectsPage, getAllObjects });
    const res = mockRes();

    await getObjects({ ...req, params: { objectTypeId: "42" }, query: { startAt: "1000" } }, res);

    expect(getObjectsPage).toHaveBeenCalledWith("42", 1000);
    expect(getAllObjects).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: "OK",
      data: { objects: [], hasMore: true, nextStartAt: 2000 },
    });
  });
});

describe("GET /sync/status", () => {
  it("adds whether a sync job is waiting in the queue", async () => {
    (getSyncStatus as jest.Mock).mockResolvedValue({ running: false, latest_run: { id: 77 } });
    (hasPendingJiraAssetsSyncJob as jest.Mock).mockResolvedValue(true);
    const res = mockRes();

    await getSyncStatusCtrl(req, res);

    expect(getSyncStatus).toHaveBeenCalledWith(5);
    expect(res.json).toHaveBeenCalledWith({
      message: "OK",
      data: { running: false, latest_run: { id: 77 }, queued: true },
    });
  });

  it("reports queued as unknown (null) when the queue does not answer", async () => {
    (getSyncStatus as jest.Mock).mockResolvedValue({ running: false });
    (hasPendingJiraAssetsSyncJob as jest.Mock).mockRejectedValue(new Error("timeout"));
    const res = mockRes();

    await getSyncStatusCtrl(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.queued).toBeNull();
  });
});

describe("POST /use-cases/remove-missing", () => {
  it("passes the admin's list through and returns the counts", async () => {
    (removeMissingUseCases as jest.Mock).mockResolvedValue({ removed: 2, skipped: 1 });
    const res = mockRes();

    await removeMissingCtrl({ ...req, body: { use_case_ids: [11, 12, 13] } }, res);

    expect(removeMissingUseCases).toHaveBeenCalledWith(5, 8, [11, 12, 13]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "OK", data: { removed: 2, skipped: 1 } });
    expect(logProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "removeMissingCtrl", userId: 8, organizationId: 5 }),
    );
    expect(logSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "Delete",
        description: expect.stringContaining("Removed 2 use case(s)"),
      }),
    );
    expect(logFailure).not.toHaveBeenCalled();
  });

  it("returns 409 'interrupted, nothing removed' when the removal lost its claim", async () => {
    (removeMissingUseCases as jest.Mock).mockRejectedValueOnce(new RunSupersededError("closed"));
    const res = mockRes();

    await removeMissingCtrl({ ...req, body: { use_case_ids: [11] } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: "Conflict",
      data: {
        message: "The removal was interrupted; nothing was removed. Try again.",
        code: "removal_interrupted",
      },
    });
    // An expected outcome, explained to the user: not event-logged as an error.
    expect(logFailure).not.toHaveBeenCalled();
  });

  it("event-logs only unexpected failures", async () => {
    (removeMissingUseCases as jest.Mock).mockRejectedValueOnce(new Error("db down"));
    const res = mockRes();

    await removeMissingCtrl({ ...req, body: { use_case_ids: [11] } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logFailure).toHaveBeenCalledWith(expect.objectContaining({ eventType: "Delete" }));
  });

  it("returns 409 while a sync is running and 400 for a bad list", async () => {
    (removeMissingUseCases as jest.Mock).mockRejectedValueOnce(
      new JiraSyncInProgressError("running"),
    );
    const res409 = mockRes();
    await removeMissingCtrl({ ...req, body: { use_case_ids: [11] } }, res409);
    expect(res409.status).toHaveBeenCalledWith(409);

    (removeMissingUseCases as jest.Mock).mockRejectedValueOnce(
      new JiraConfigValidationError("use_case_ids must be a list"),
    );
    const res400 = mockRes();
    await removeMissingCtrl({ ...req, body: {} }, res400);
    expect(res400.status).toHaveBeenCalledWith(400);
    expect(logFailure).not.toHaveBeenCalled();
  });
});

describe("DELETE /use-cases/:id", () => {
  it("deletes through the service with the caller's user id, and logs it", async () => {
    (deleteUseCaseByProjectId as jest.Mock).mockResolvedValueOnce({
      unlinked: false,
      links_removed: 2,
    });
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "111" } }, res);

    expect(deleteUseCaseByProjectId).toHaveBeenCalledWith(111, 5, 8);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: "OK",
      data: { success: true, unlinked: false, links_removed: 2 },
    });
    expect(logSuccess).toHaveBeenCalledWith(expect.objectContaining({ eventType: "Delete" }));
  });

  it.each([
    [() => new JiraUseCaseNotFoundError("Use case not found"), 404],
    [() => new JiraSyncInProgressError("running"), 409],
  ])("maps %p to its status without event-logging a failure", async (makeErr, status) => {
    (deleteUseCaseByProjectId as jest.Mock).mockRejectedValueOnce(makeErr());
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "111" } }, res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(logFailure).not.toHaveBeenCalled();
  });

  it("returns the same 409 removal_interrupted as a removal when it lost its claim", async () => {
    (deleteUseCaseByProjectId as jest.Mock).mockRejectedValueOnce(new RunSupersededError("closed"));
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "111" } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: "Conflict",
      data: {
        message: "The removal was interrupted; nothing was removed. Try again.",
        code: "removal_interrupted",
      },
    });
    expect(logFailure).not.toHaveBeenCalled();
  });

  it("reports a link cleaned up (project not in this org) as unlinked, not removed", async () => {
    (deleteUseCaseByProjectId as jest.Mock).mockResolvedValueOnce({
      unlinked: true,
      links_removed: 0,
    });
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "999" } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: "OK",
      data: { success: true, unlinked: true, links_removed: 0 },
    });
  });

  it("returns 500 with a message naming the use case when its project could not be deleted", async () => {
    const message =
      "Use case 111 (project 111) could not be deleted, so nothing was removed. Try again.";
    (deleteUseCaseByProjectId as jest.Mock).mockRejectedValueOnce(
      new JiraUseCaseDeleteFailedError(message),
    );
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "111" } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Internal Server Error", error: message });
    expect(logFailure).toHaveBeenCalled();
  });

  it("rejects a non-numeric id with 400 before deleting", async () => {
    const res = mockRes();

    await deleteUseCaseCtrl({ ...req, params: { id: "abc" } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(deleteUseCaseByProjectId).not.toHaveBeenCalled();
  });
});
