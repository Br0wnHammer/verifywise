import {
  ABANDONED_RUN_MESSAGE,
  claimSyncRun,
  deleteUseCaseByProjectId,
  IMPORT_MAX_OBJECTS,
  errorMessage,
  finalizeFailure,
  getSyncStatus,
  importObjects,
  JiraConfigValidationError,
  JiraImportInterruptedError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  JiraUseCaseNotFoundError,
  parseSyncIntervalHours,
  removeMissingUseCases,
  RunRef,
  runClaimedSync,
  runQueuedSync,
  saveConfig,
  startManualSync,
  startScheduledSync,
  SKIPPED_RUN_MESSAGE,
  SQL_RUN_IS_LIVE,
  touchHeartbeat,
  RunSupersededError,
  updateSelection,
  updateSyncSettings,
} from "../jiraAssets.service";
import { sequelize } from "../../../database/db";
import { decryptText } from "../../../tools/createSecureValue";
import { JiraAssetsClient } from "../jira.client";
import { deleteProjectByIdQuery } from "../../../utils/project.utils";
import {
  getPendingApprovalRequestIdQuery,
  withdrawApprovalRequestQuery,
} from "../../../utils/approvalRequest.utils";
import { recordUseCaseDeletion } from "../../../utils/useCaseChangeHistory.utils";
import {
  BackgroundJobsUnavailableError,
  enqueueJiraAssetsSyncRun,
} from "../../../services/automations/automationProducer";

const FAKE_TX = { id: "tx" };
const RUN: RunRef = { historyId: 77, token: "tok-77" };

jest.mock("../../../database/db", () => ({
  sequelize: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));
jest.mock("../../../tools/createSecureValue", () => ({
  encryptText: jest.fn(() => ({ value: "enc", iv: "iv" })),
  decryptText: jest.fn(),
}));
jest.mock("../jira.client", () => {
  class JiraUpstreamError extends Error {}
  return { JiraAssetsClient: jest.fn(), JiraUpstreamError, WORKER_SYNC_DEADLINE_MS: 600_000 };
});
jest.mock("../../../services/automations/automationProducer", () => {
  class BackgroundJobsUnavailableError extends Error {}
  return { enqueueJiraAssetsSyncRun: jest.fn(), BackgroundJobsUnavailableError };
});
jest.mock("../../../utils/project.utils", () => ({ deleteProjectByIdQuery: jest.fn() }));
jest.mock("../../../utils/approvalRequest.utils", () => ({
  getPendingApprovalRequestIdQuery: jest.fn(),
  withdrawApprovalRequestQuery: jest.fn(),
}));
jest.mock("../../../utils/useCaseChangeHistory.utils", () => ({
  recordUseCaseDeletion: jest.fn(),
}));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));

const mockQuery = sequelize.query as jest.Mock;
const mockTransaction = sequelize.transaction as unknown as jest.Mock;
const mockDecrypt = decryptText as jest.Mock;
const MockClient = JiraAssetsClient as unknown as jest.Mock;
const mockEnqueue = enqueueJiraAssetsSyncRun as jest.Mock;
const mockDeleteProject = deleteProjectByIdQuery as jest.Mock;
const mockPendingApproval = getPendingApprovalRequestIdQuery as jest.Mock;
const mockWithdrawApproval = withdrawApprovalRequestQuery as jest.Mock;
const mockRecordDeletion = recordUseCaseDeletion as jest.Mock;

const CONFIG_ROW = {
  id: 1,
  jira_base_url: "https://x.atlassian.net",
  workspace_id: "w",
  email: "a@b.co",
  api_token_encrypted: "enc",
  api_token_iv: "iv",
  deployment_type: "cloud",
  selected_object_type_id: "42",
};

const jiraObject = (id: string) => ({
  id,
  objectKey: `AI-${id}`,
  label: `System ${id}`,
  objectType: { id: "42", name: "AI System" },
  attributes: [],
  created: "2026-01-01",
  updated: "2026-01-02",
});

const link = (id: string, projectId: number | null, objectTypeId: string | null = "42") => ({
  jira_object_id: id,
  project_id: projectId,
  object_type_id: objectTypeId,
});

interface FakeDb {
  config?: Record<string, unknown> | null;
  existing?: Array<ReturnType<typeof link>>;
  running?: Array<{ id: number }>;
  /** Rows a heartbeat UPDATE affects; [] means this run no longer owns its row. */
  heartbeat?: Array<{ id: number }>;
  /** Rows the in-transaction ownership check (FOR SHARE) finds; [] means the claim was lost. */
  owned?: Array<{ id: number }>;
  /** Project ids that are not in this organization (the project lock finds nothing). */
  foreignProjects?: number[];
  /** Link rows the unlocked pre-check of DELETE /use-cases/:id finds. */
  linkedProject?: Array<{ id: number }>;
  /** Whether the per-object update finds the link row (false: deleted since the walk). */
  linkExists?: boolean;
  /** Rows the run's own finalize UPDATE affects. */
  ownRow?: Array<{ id: number }>;
  /** Rows the missing-flag UPDATE returns (newly flagged). */
  flagged?: Array<{ id: number }>;
  /** Use cases still flagged when a removal locks them. */
  stillFlagged?: Array<{ id: number; project_id: number | null }>;
  live?: boolean;
  latestRunId?: number | null;
}

/** Route sequelize.query by SQL text, so tests read as scenarios, not call orders. */
function fakeDb({
  config = CONFIG_ROW,
  existing = [],
  running = [],
  heartbeat = [{ id: 77 }],
  owned = [{ id: 77 }],
  linkExists = true,
  linkedProject = [{ id: 11 }],
  foreignProjects = [],
  ownRow = [{ id: 77 }],
  flagged = [],
  stillFlagged = [],
  live = false,
  latestRunId = 40,
}: FakeDb = {}) {
  mockQuery.mockImplementation(async (sql: string, opts: any = {}) => {
    if (sql.includes("WITH own AS")) {
      const isOwned = owned.length > 0;
      return [{ owned: owned.length, links: isOwned && linkExists ? 1 : 0, projects: 0 }];
    }
    if (sql.includes("FOR SHARE")) return owned;
    if (sql.includes("WHERE project_id = :projectId")) return linkedProject;
    if (sql.includes("SELECT id FROM projects")) {
      const projectId = opts.replacements?.projectId;
      return foreignProjects.includes(projectId) ? [] : [{ id: projectId }];
    }
    if (sql.includes("SET heartbeat_at")) return [heartbeat, {}];
    if (sql.includes("pg_advisory_xact_lock")) return [{}];
    if (sql.includes("SET status = 'failed', completed_at")) return [[], 0];
    if (sql.includes("ORDER BY started_at DESC, id DESC LIMIT 1")) {
      return latestRunId === null ? [] : [{ id: latestRunId }];
    }
    if (sql.includes("SELECT id FROM jira_assets_sync_history")) return running;
    if (sql.includes("INSERT INTO jira_assets_sync_history")) return [[{ id: 77 }], 1];
    if (sql.includes("AS live")) return [{ live }];
    if (sql.includes("SELECT id, jira_base_url")) return config ? [config] : [];
    if (sql.includes("SELECT * FROM jira_assets_config")) return config ? [config] : [];
    if (sql.includes("SELECT jira_object_id, project_id")) return existing;
    if (sql.includes("SELECT id, project_id FROM jira_assets_use_cases")) return stillFlagged;
    if (sql.includes("SELECT id FROM jira_assets_use_cases")) return [];
    if (sql.includes("nextval")) return [{ seq: "9" }];
    if (sql.includes("INSERT INTO projects")) return [[{ id: 500 }], 1];
    if (sql.includes("SET missing_in_jira_since = (NOW()")) return [flagged, {}];
    if (sql.includes("SET status = 'completed'")) return [ownRow, {}];
    if (sql.includes("SET status = 'failed', error_message")) return [ownRow, {}];
    if (sql.includes("DELETE FROM jira_assets_use_cases")) {
      return [(opts.replacements?.linkIds ?? []).map((id: number) => ({ id })), {}];
    }
    return [[], {}];
  });
}

const sqlCalls = (fragment: string) =>
  mockQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));

function clientReturning(
  objects: ReturnType<typeof jiraObject>[],
  complete = true,
  stoppedReason?: "deadline",
) {
  const getAllObjects = jest.fn(
    async (_typeId: string, options: { onPage?: () => Promise<void> } = {}) => {
      if (options.onPage) await options.onPage();
      return { objects, complete, stoppedReason };
    },
  );
  MockClient.mockImplementation(() => ({ getAllObjects }));
  return getAllObjects;
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset also drops queued *Once values a refused claim leaves unused.
  mockQuery.mockReset();
  mockTransaction.mockReset();
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX));
  mockDecrypt.mockReturnValue({ success: true, data: "token" });
  mockEnqueue.mockResolvedValue({ jobId: "jira-assets-sync-5", queued: true });
  mockDeleteProject.mockResolvedValue(true);
  mockPendingApproval.mockResolvedValue(null);
});

describe("claimSyncRun (overlap guard + run token)", () => {
  it("records a new run with a random token, start and heartbeat set in SQL", async () => {
    fakeDb();

    const run = await claimSyncRun(5, "scheduled", null);

    expect(run.historyId).toBe(77);
    expect(run.token).toMatch(/^[0-9a-f-]{36}$/);
    const [insertSql, insertOptions] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insertSql).toContain("run_token");
    expect(insertSql).toContain("(NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')");
    expect(insertOptions.replacements).toEqual({
      organizationId: 5,
      syncType: "scheduled",
      triggeredBy: null,
      token: run.token,
    });
  });

  it("gives every claim its own token", async () => {
    fakeDb();

    const a = await claimSyncRun(5, "manual", 3);
    const b = await claimSyncRun(5, "manual", 3);

    expect(a.token).not.toBe(b.token);
  });

  it("refuses when a run is already going and inserts nothing", async () => {
    fakeDb({ running: [{ id: 12 }] });

    await expect(claimSyncRun(5, "manual", 3)).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("decides staleness in SQL: no heartbeat for 15 minutes", async () => {
    fakeDb();

    await claimSyncRun(5, "import", 3);

    const [sql, options] = sqlCalls("SET status = 'failed', completed_at")[0];
    expect(sql).toContain(`NOT ${SQL_RUN_IS_LIVE}`);
    expect(options.replacements.abandonedMessage).toBe(ABANDONED_RUN_MESSAGE);
  });
});

describe("touchHeartbeat", () => {
  it("matches the run's id and token", async () => {
    fakeDb();

    await touchHeartbeat(RUN, 5);

    const [sql, options] = sqlCalls("SET heartbeat_at")[0];
    expect(sql).toContain("run_token = :token");
    expect(options.replacements).toEqual({ id: 77, organizationId: 5, token: "tok-77" });
  });

  it("throws RunSupersededError when this run no longer owns a started row", async () => {
    fakeDb({ heartbeat: [] });

    await expect(touchHeartbeat(RUN, 5)).rejects.toBeInstanceOf(RunSupersededError);
  });

  it("does not swallow a database error", async () => {
    mockQuery.mockRejectedValue(new Error("db hiccup"));

    await expect(touchHeartbeat(RUN, 5)).rejects.toThrow("db hiccup");
  });
});

describe("runClaimedSync — never deletes, flags missing objects", () => {
  it("scheduled: updates linked use cases, clears their flag, creates nothing", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")]);

    const result = await runClaimedSync(5, RUN, null, "scheduled");

    expect(result.success).toBe(true);
    expect(result.objectsUpdated).toBe(1);
    expect(result.objectsCreated).toBe(0);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("missing_in_jira_since = NULL")).toHaveLength(1);
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("flags linked objects missing from a complete walk, keeping the earliest date", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102), link("4", null)], flagged: [{ id: 2 }] });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(true);
    expect(result.objectsMissingInJira).toBe(2);
    expect(result.objectsNewlyMissing).toBe(1);
    expect(result.missingInJiraIds).toEqual(["2", "4"]);
    const [flagSql, flagOptions] = sqlCalls("SET missing_in_jira_since = (NOW()")[0];
    expect(flagSql).toContain("AND missing_in_jira_since IS NULL");
    expect(flagSql).toContain("data->'objectType'->>'id' = :objectTypeId");
    expect(flagSql).toMatch(/own\.run_token = :runToken\s+AND own\.status = 'started'/);
    expect(flagOptions.replacements).toEqual({
      organizationId: 5,
      missingIds: ["2", "4"],
      objectTypeId: "42",
      historyId: 77,
      runToken: "tok-77",
    });
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements).toMatchObject({ objectsDeleted: 0 });
    expect(completed.replacements.note).toContain("flagged as missing (nothing was removed)");
  });

  it("never flags links from another object type (type switched A → B)", async () => {
    // Links imported from type "7" (A); the config now walks type "42" (B).
    fakeDb({ existing: [link("a1", 201, "7"), link("a2", 202, "7"), link("b1", 101)] });
    clientReturning([jiraObject("b1")], true);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(true);
    expect(result.objectsMissingInJira).toBe(0);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements.note).toContain(
      "2 use case(s) from another or an unknown object type were left as they were",
    );
  });

  it("flags only same-type links when types are mixed; unknown types are left alone", async () => {
    fakeDb({
      existing: [link("1", 101), link("2", 102), link("a1", 201, "7"), link("u1", 301, null)],
      flagged: [{ id: 2 }],
    });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.missingInJiraIds).toEqual(["2"]);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")[0][1].replacements.missingIds).toEqual([
      "2",
    ]);
  });

  it("clears a seen object's flag only while the run owns its claim", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")], true);

    await runClaimedSync(5, RUN, 8, "manual");

    const [clearSql, clear] = sqlCalls("missing_in_jira_since = NULL")[0];
    expect(clearSql).toMatch(/run_token = :runToken\s+AND status = 'started'/);
    expect(clearSql).toContain("FOR SHARE");
    expect(clearSql).toContain("AND EXISTS (SELECT 1 FROM own)");
    expect(clear.replacements).toMatchObject({ historyId: 77, runToken: "tok-77" });
  });

  it("sets no flags after an incomplete walk, but still clears flags for objects it saw", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1")], false);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(true);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    expect(sqlCalls("missing_in_jira_since = NULL")).toHaveLength(1);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements.note).toContain("did not confirm it returned every object");
  });

  it("sets no flags when Jira returns no objects at all", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([], true);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(true);
    expect(sqlCalls("SET missing_in_jira_since = (NOW()")).toHaveLength(0);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements.note).toContain("returned no objects");
  });

  it("manual: creates new objects owned by the user, in one transaction", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.objectsCreated).toBe(1);
    const [, projectInsert] = sqlCalls("INSERT INTO projects")[0];
    expect(projectInsert.replacements.owner).toBe(8);
    expect(projectInsert.transaction).toBe(FAKE_TX);
    expect(sqlCalls("INSERT INTO jira_assets_use_cases")[0][1].transaction).toBe(FAKE_TX);
  });

  it("fails without changing anything when the fetch deadline is hit", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")], false, "deadline");

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("did not return every object within 10 minutes");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
  });

  it("writes nothing more once it has lost its claim mid-way", async () => {
    fakeDb({ existing: [link("1", 101)], heartbeat: [] });
    clientReturning([jiraObject("1")]);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("closed by another run");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(0);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("updates each linked object in one statement that locks and checks the claim", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1"), jiraObject("2")]);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.objectsUpdated).toBe(2);
    // One round trip per object: no separate ownership query or transaction.
    const updates = sqlCalls("WITH own AS");
    expect(updates).toHaveLength(2);
    expect(mockTransaction).not.toHaveBeenCalled();
    const [sql, options] = updates[0];
    expect(sql).toContain("UPDATE jira_assets_use_cases");
    expect(sql).toContain("UPDATE projects p");
    expect(sql).toContain("FROM link");
    expect(sql).not.toContain("AS projects");
    expect(options.replacements).toMatchObject({
      jiraObjectId: "1",
      title: "System 1",
      historyId: 77,
      runToken: "tok-77",
      organizationId: 5,
    });
  });

  it("does not count an object whose link row was deleted since the walk began", async () => {
    fakeDb({ existing: [link("1", 101)], linkExists: false });
    clientReturning([jiraObject("1")]);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(true);
    expect(result.objectsUpdated).toBe(0);
  });

  it("stops at the next object, writing nothing, once another claim closed the run", async () => {
    // Heartbeats would still pass here; the per-object check is what stops it.
    fakeDb({ existing: [link("1", 101), link("2", 102)], owned: [] });
    clientReturning([jiraObject("1"), jiraObject("2"), jiraObject("3")]);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("closed by another run");
    // The first object's guarded statement found no claim (so wrote nothing);
    // no later object was tried.
    expect(sqlCalls("WITH own AS")).toHaveLength(1);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(0);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("manual: does not create a use case once the run lost its claim", async () => {
    fakeDb({ existing: [], owned: [] });
    clientReturning([jiraObject("3")]);

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(false);
    expect(sqlCalls("nextval")).toHaveLength(0);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
  });

  it("stops (and records the failure) when a heartbeat hits a database error", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, opts: unknown) => {
      if (sql.includes("SET heartbeat_at")) throw new Error("db hiccup");
      return base(sql, opts);
    });

    const result = await runClaimedSync(5, RUN, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("db hiccup");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
  });

  it("records a token decrypt failure on the history row and the config", async () => {
    fakeDb({ existing: [link("1", 101)] });
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    const result = await runClaimedSync(5, RUN, null, "scheduled");

    expect(result.success).toBe(false);
    const [, history] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(history.replacements).toMatchObject({ id: 77, organizationId: 5, token: "tok-77" });
    expect(sqlCalls("last_sync_status = 'failed'")).toHaveLength(1);
  });

  it("leaves the config alone when its own row was already closed at finish", async () => {
    fakeDb({ existing: [link("1", 101)], ownRow: [] });
    clientReturning([jiraObject("1")]);

    const result = await runClaimedSync(5, RUN, null, "scheduled");

    expect(result.success).toBe(false);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });
});

describe("startManualSync (Sync now queues a job)", () => {
  it("queues the job and returns its id and the newest run before it", async () => {
    fakeDb({ latestRunId: 40 });

    await expect(startManualSync(5, 8)).resolves.toEqual({
      jobId: "jira-assets-sync-5",
      previousRunId: 40,
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      organizationId: 5,
      triggeredBy: 8,
      syncType: "manual",
    });
    // The worker claims at pickup; nothing is claimed here.
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("refuses with 409 when a run is live", async () => {
    fakeDb({ live: true });

    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("refuses with 409 when a job for the org is already waiting", async () => {
    fakeDb();
    mockEnqueue.mockResolvedValue({ jobId: "jira-assets-sync-5", queued: false });

    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraSyncInProgressError);
  });

  it("passes a queue outage through (503 in the controller)", async () => {
    fakeDb();
    mockEnqueue.mockRejectedValue(new BackgroundJobsUnavailableError());

    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(BackgroundJobsUnavailableError);
  });

  it("rejects without a config or an object type", async () => {
    fakeDb({ config: null });
    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraNotConfiguredError);

    fakeDb({ config: { ...CONFIG_ROW, selected_object_type_id: null } });
    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraConfigValidationError);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("scheduled: queues a refresh-only job with no user", async () => {
    await startScheduledSync(5);

    expect(mockEnqueue).toHaveBeenCalledWith({
      organizationId: 5,
      triggeredBy: null,
      syncType: "scheduled",
    });
  });
});

describe("runQueuedSync (worker claims at pickup)", () => {
  it("fails closed without a valid org or sync type, before claiming", async () => {
    await expect(runQueuedSync({ syncType: "manual" })).rejects.toThrow("organizationId");
    await expect(runQueuedSync({ organizationId: 5, syncType: "full" })).rejects.toThrow(
      "syncType",
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("claims the run when the job is picked up, then runs it", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);

    const result = await runQueuedSync({ organizationId: 5, triggeredBy: 8, syncType: "manual" });

    expect(result?.success).toBe(true);
    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "manual", triggeredBy: 8 });
  });

  it("skips a scheduled run quietly when another run is live", async () => {
    fakeDb({ running: [{ id: 3 }] });
    const getAllObjects = clientReturning([jiraObject("1")]);

    await expect(
      runQueuedSync({ organizationId: 5, triggeredBy: null, syncType: "scheduled" }),
    ).resolves.toBeNull();
    expect(getAllObjects).not.toHaveBeenCalled();
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("records a skipped manual run so the panel can say why it did not start", async () => {
    fakeDb({ running: [{ id: 3 }] });

    await expect(
      runQueuedSync({ organizationId: 5, triggeredBy: 8, syncType: "manual" }),
    ).resolves.toBeNull();

    const inserts = sqlCalls("INSERT INTO jira_assets_sync_history");
    expect(inserts).toHaveLength(1);
    const [sql, options] = inserts[0];
    expect(sql).toContain("'manual', 'failed'");
    expect(sql).not.toContain("run_token");
    expect(options.replacements).toEqual({
      organizationId: 5,
      triggeredBy: 8,
      message: SKIPPED_RUN_MESSAGE,
    });
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("falls back to no user when triggeredBy is invalid", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")]);

    await runQueuedSync({ organizationId: 5, triggeredBy: "nobody", syncType: "manual" });

    expect(sqlCalls("INSERT INTO projects")[0][1].replacements.owner).toBeNull();
  });
});

describe("removeMissingUseCases", () => {
  it("validates the id list before claiming", async () => {
    for (const bad of [undefined, [], ["1"], [0], [1.5], new Array(1001).fill(1)]) {
      await expect(removeMissingUseCases(5, 8, bad)).rejects.toBeInstanceOf(
        JiraConfigValidationError,
      );
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("removes only the listed use cases that are still flagged, in one transaction", async () => {
    fakeDb({
      stillFlagged: [
        { id: 11, project_id: 111 },
        { id: 12, project_id: null },
      ],
    });

    const result = await removeMissingUseCases(5, 8, [11, 12, 13, 13]);

    // 12 has no project: only its link goes, reported as unlinked.
    expect(result).toEqual({ removed: 1, unlinked: 1, skipped: 1, skipped_ids: [13] });
    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "remove_missing", triggeredBy: 8 });
    const [lockSql, lock] = sqlCalls("SELECT id, project_id FROM jira_assets_use_cases")[0];
    expect(lockSql).toContain("missing_in_jira_since IS NOT NULL");
    expect(lockSql).toContain("FOR UPDATE");
    expect(lock.replacements).toEqual({ organizationId: 5, ids: [11, 12, 13] });
    // The run's own row is share-locked first, so no claim can close it mid-way.
    const ownership = sqlCalls("FOR SHARE")[0];
    expect(ownership[1]).toMatchObject({
      replacements: { id: 77, organizationId: 5, token: expect.any(String) },
      transaction: FAKE_TX,
    });
    expect(mockQuery.mock.calls.indexOf(ownership)).toBeLessThan(
      mockQuery.mock.calls.indexOf(sqlCalls("SELECT id, project_id FROM jira_assets_use_cases")[0]),
    );
    // Projects go through the core deletion path, never a bare DELETE.
    expect(sqlCalls("DELETE FROM projects")).toHaveLength(0);
    expect(mockDeleteProject).toHaveBeenCalledTimes(1);
    expect(mockDeleteProject).toHaveBeenCalledWith(111, 5, FAKE_TX, {
      enqueueAutomationAfterCommit: true,
    });
    expect(mockRecordDeletion).toHaveBeenCalledWith(111, 8, 5, FAKE_TX);
    // History is written only after the project was deleted.
    expect(mockRecordDeletion.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDeleteProject.mock.invocationCallOrder[0],
    );
    expect(sqlCalls("DELETE FROM jira_assets_use_cases")[0][1]).toMatchObject({
      replacements: { organizationId: 5, linkIds: [12] },
      transaction: FAKE_TX,
    });
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed).toMatchObject({ transaction: FAKE_TX });
    expect(completed.replacements).toMatchObject({ objectsDeleted: 1 });
    expect(completed.replacements.note).toContain("1 link(s)");
  });

  it("cannot run while a sync is running", async () => {
    fakeDb({ running: [{ id: 3 }] });

    await expect(removeMissingUseCases(5, 8, [11])).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("throws (rolling the deletes back) if it lost its claim before finishing", async () => {
    fakeDb({ stillFlagged: [{ id: 11, project_id: 111 }], ownRow: [] });

    await expect(removeMissingUseCases(5, 8, [11])).rejects.toBeInstanceOf(RunSupersededError);
  });

  it("deletes nothing when the claim was already lost when its transaction began", async () => {
    fakeDb({ stillFlagged: [{ id: 11, project_id: 111 }], owned: [] });

    await expect(removeMissingUseCases(5, 8, [11])).rejects.toBeInstanceOf(RunSupersededError);
    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(0);
  });

  it("cross-org link in a removal: approval untouched, only the link goes (unlinked)", async () => {
    fakeDb({
      stillFlagged: [
        { id: 11, project_id: 111 },
        { id: 12, project_id: 112 },
      ],
      foreignProjects: [112],
    });
    mockPendingApproval.mockImplementation(async (projectId: number) =>
      projectId === 111 ? 900 : 901,
    );

    const result = await removeMissingUseCases(5, 8, [11, 12]);

    expect(result).toEqual({ removed: 1, unlinked: 1, skipped: 0, skipped_ids: [] });
    // The project row is locked before anything else happens to it.
    expect(sqlCalls("SELECT id FROM projects")[0][0]).toContain("FOR UPDATE");
    // 112 is not this org's: no approval looked up or withdrawn, no project
    // deleted, no change history; only its link row is deleted.
    expect(mockPendingApproval).toHaveBeenCalledTimes(1);
    expect(mockPendingApproval).toHaveBeenCalledWith(111, "use_case", 5, FAKE_TX);
    expect(mockWithdrawApproval).toHaveBeenCalledTimes(1);
    expect(mockWithdrawApproval).toHaveBeenCalledWith(900, 5, FAKE_TX);
    expect(mockDeleteProject).toHaveBeenCalledTimes(1);
    expect(mockRecordDeletion).toHaveBeenCalledTimes(1);
    expect(mockRecordDeletion).toHaveBeenCalledWith(111, 8, 5, FAKE_TX);
    expect(sqlCalls("DELETE FROM jira_assets_use_cases")[0][1].replacements).toMatchObject({
      linkIds: [12],
    });
  });

  it(`rejects more than ${IMPORT_MAX_OBJECTS} ids (same cap as an import)`, async () => {
    const ids = Array.from({ length: IMPORT_MAX_OBJECTS + 1 }, (_, i) => i + 1);

    await expect(removeMissingUseCases(5, 8, ids)).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("deleteUseCaseByProjectId", () => {
  it("deletes a linked use case through the shared claimed flow", async () => {
    fakeDb({ stillFlagged: [{ id: 11, project_id: 111 }] });

    await expect(deleteUseCaseByProjectId(111, 5, 8)).resolves.toEqual({ unlinked: false });

    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "remove_missing", triggeredBy: 8 });
    expect(sqlCalls("FOR SHARE")[0][1]).toMatchObject({ transaction: FAKE_TX });
    const [lockSql, lock] = sqlCalls("SELECT id, project_id FROM jira_assets_use_cases")[0];
    expect(lockSql).toContain("project_id IN (:ids)");
    expect(lockSql).not.toContain("missing_in_jira_since IS NOT NULL");
    expect(lockSql).toContain("FOR UPDATE");
    expect(lock.replacements).toEqual({ organizationId: 5, ids: [111] });
    expect(mockDeleteProject).toHaveBeenCalledWith(111, 5, FAKE_TX, {
      enqueueAutomationAfterCommit: true,
    });
    expect(mockRecordDeletion).toHaveBeenCalledWith(111, 8, 5, FAKE_TX);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed).toMatchObject({ transaction: FAKE_TX });
    expect(completed.replacements).toMatchObject({ objectsDeleted: 1 });
  });

  it("is 404 for a project that is not a Jira Assets use case, without claiming", async () => {
    fakeDb({ linkedProject: [] });

    await expect(deleteUseCaseByProjectId(111, 5, 8)).rejects.toBeInstanceOf(
      JiraUseCaseNotFoundError,
    );
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
    expect(sqlCalls("pg_advisory_xact_lock")).toHaveLength(0);
  });

  it("is 404, not 409, for a non-linked id while a sync is running", async () => {
    fakeDb({ linkedProject: [], running: [{ id: 3 }] });

    await expect(deleteUseCaseByProjectId(111, 5, 8)).rejects.toBeInstanceOf(
      JiraUseCaseNotFoundError,
    );
    expect(sqlCalls("pg_advisory_xact_lock")).toHaveLength(0);
  });

  it("is 404 with no history row when the link vanished after the pre-check", async () => {
    fakeDb({ stillFlagged: [] });

    await expect(deleteUseCaseByProjectId(111, 5, 8)).rejects.toBeInstanceOf(
      JiraUseCaseNotFoundError,
    );
    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(sqlCalls("SET status = 'completed'")).toHaveLength(0);
    // Not recorded as a failed run: the claimed row is removed instead.
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(0);
    const [releaseSql, release] = sqlCalls("DELETE FROM jira_assets_sync_history")[0];
    expect(releaseSql).toContain("run_token = :token AND status = 'started'");
    expect(release.replacements).toMatchObject({ id: 77, organizationId: 5 });
  });

  it("is 409 while a sync, import or removal runs", async () => {
    fakeDb({ running: [{ id: 3 }] });

    await expect(deleteUseCaseByProjectId(111, 5, 8)).rejects.toBeInstanceOf(
      JiraSyncInProgressError,
    );
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });

  it("a link to another org's project: only the link goes, reported as unlinked", async () => {
    fakeDb({ stillFlagged: [{ id: 11, project_id: 999 }], foreignProjects: [999] });

    await expect(deleteUseCaseByProjectId(999, 5, 8)).resolves.toEqual({ unlinked: true });

    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(mockPendingApproval).not.toHaveBeenCalled();
    expect(mockRecordDeletion).not.toHaveBeenCalled();
    expect(sqlCalls("DELETE FROM jira_assets_use_cases")[0][1].replacements).toMatchObject({
      linkIds: [11],
    });
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements).toMatchObject({ objectsDeleted: 0 });
  });

  it("still closes the run as failed on an unexpected error", async () => {
    fakeDb({ stillFlagged: [{ id: 11, project_id: 111 }] });
    mockDeleteProject.mockRejectedValue(new Error("db down"));

    await expect(deleteUseCaseByProjectId(111, 5, 8)).rejects.toThrow("db down");
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(1);
    expect(sqlCalls("DELETE FROM jira_assets_sync_history")).toHaveLength(0);
  });
});

describe("finalizeFailure", () => {
  it("only closes its own row (id and token) while it is still started", async () => {
    mockQuery.mockResolvedValue([[{ id: 77 }], {}]);

    await finalizeFailure(RUN, 5, new Error("boom"));

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("run_token = :token AND status = 'started'");
    expect(options.replacements).toMatchObject({
      id: 77,
      organizationId: 5,
      token: "tok-77",
      message: "boom",
    });
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(1);
  });

  it("skips the config update when its row was already closed", async () => {
    mockQuery.mockResolvedValue([[], {}]);

    await finalizeFailure(RUN, 5, new Error("boom"));

    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("can record on the history row only (imports, removals)", async () => {
    mockQuery.mockResolvedValue([[{ id: 77 }], {}]);

    await finalizeFailure(RUN, 5, new Error("boom"), false);

    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("never throws when the database write fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));

    await expect(finalizeFailure(RUN, 5, new Error("boom"))).resolves.toBe("boom");
  });

  it.each([
    [undefined, "Unknown error"],
    [null, "Unknown error"],
    ["plain string", "plain string"],
    [{ message: "" }, "[object Object]"],
    [new Error(""), "Error"],
  ])("falls back to a usable message for %p", (err, expected) => {
    expect(errorMessage(err)).toBe(expected);
  });
});

describe("importObjects", () => {
  it(`rejects more than ${IMPORT_MAX_OBJECTS} objects before claiming`, async () => {
    fakeDb();
    const ids = Array.from({ length: IMPORT_MAX_OBJECTS + 1 }, (_, i) => String(i));

    await expect(importObjects(5, 8, ids)).rejects.toBeInstanceOf(JiraConfigValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns the ids of the objects that failed, next to their errors", async () => {
    fakeDb();
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(async (id: string) => {
        if (id === "2") throw new Error("not found");
        return jiraObject(id);
      }),
    }));

    const result = await importObjects(5, 8, ["1", "2", "3"]);

    expect(result).toMatchObject({ imported: 2, skipped: 0, failed_ids: ["2"] });
    expect(result.errors).toEqual(["Failed to import 2: not found"]);
  });

  it("heartbeats while skipping objects that are already linked", async () => {
    fakeDb();
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, opts: unknown) => {
      if (sql.includes("SELECT id FROM jira_assets_use_cases")) return [{ id: 1 }];
      return base(sql, opts);
    });
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(),
    }));
    const ids = Array.from({ length: 50 }, (_, i) => String(i));

    const result = await importObjects(5, 8, ids);

    expect(result).toMatchObject({ imported: 0, skipped: 50 });
    expect(sqlCalls("SET heartbeat_at")).toHaveLength(2);
  });

  it("stops at once, not as a per-object error, when the claim is lost before a create", async () => {
    fakeDb({ owned: [] });
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(async (id: string) => jiraObject(id)),
    }));

    const err = await importObjects(5, 8, ["1", "2"]).catch((e) => e);

    expect(err).toBeInstanceOf(JiraImportInterruptedError);
    expect(err).toMatchObject({ imported: 0, skipped: 0 });
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("FOR SHARE")).toHaveLength(1);
  });

  it("takes the same claim as sync, so it cannot run during a sync", async () => {
    fakeDb({ running: [{ id: 3 }] });

    await expect(importObjects(5, 8, ["1"])).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
  });

  it("rejects before claiming when Jira is not configured", async () => {
    fakeDb({ config: null });

    await expect(importObjects(5, 8, ["1"])).rejects.toBeInstanceOf(JiraNotConfiguredError);
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("records an import failure on the history row only, never on the config", async () => {
    fakeDb();
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    await expect(importObjects(5, 8, ["1"])).rejects.toThrow("bad key");
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(1);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("records the import and counts a unique violation as skipped", async () => {
    fakeDb();
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(async (id: string) => jiraObject(id)),
    }));
    const unique = Object.assign(new Error("duplicate"), {
      name: "SequelizeUniqueConstraintError",
    });
    mockTransaction
      .mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX)) // claim
      .mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX)) // object 1
      .mockImplementationOnce(async () => {
        throw unique; // object 2 was linked concurrently
      });

    const result = await importObjects(5, 8, ["1", "2"]);

    expect(result).toEqual({ success: true, imported: 1, skipped: 1, errors: undefined });
    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "import", triggeredBy: 8 });
  });

  it("reports how many objects were imported when another run took over", async () => {
    fakeDb({ ownRow: [] });
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(async (id: string) => jiraObject(id)),
    }));

    const err = await importObjects(5, 8, ["1", "2"]).catch((e) => e);

    expect(err).toBeInstanceOf(JiraImportInterruptedError);
    expect(err).toMatchObject({ imported: 2, skipped: 0 });
  });
});

describe("getSyncStatus", () => {
  it("returns the latest run with liveness computed in SQL", async () => {
    mockQuery.mockResolvedValue([{ running: false, latest_run: { id: 77 } }]);

    await getSyncStatus(5);

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain(`(h.status = 'started' AND ${SQL_RUN_IS_LIVE}) AS is_live`);
    expect(sql).toContain("END AS code");
    expect(options.replacements).toEqual({
      organizationId: 5,
      abandonedMessage: ABANDONED_RUN_MESSAGE,
      abandonedCode: "abandoned",
      skippedMessage: SKIPPED_RUN_MESSAGE,
      skippedCode: "skipped",
    });
  });
});

describe("updateSyncSettings (partial patch)", () => {
  it("updates only the sync fields that were sent", async () => {
    mockQuery.mockResolvedValue([[{ sync_enabled: true, sync_interval_hours: 24 }], 1]);

    const result = await updateSyncSettings(5, 8, { sync_enabled: true });

    expect(result).toEqual({ sync_enabled: true, sync_interval_hours: 24 });
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("COALESCE(:syncEnabled, sync_enabled)");
    expect(sql).not.toMatch(/jira_base_url|api_token|selected_schema_id|email/);
    expect(options.replacements).toEqual({
      syncEnabled: true,
      syncIntervalHours: null,
      userId: 8,
      organizationId: 5,
    });
  });

  it("validates the input before touching the database", async () => {
    await expect(updateSyncSettings(5, 8, { sync_interval_hours: 0 })).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    await expect(updateSyncSettings(5, 8, {})).rejects.toBeInstanceOf(JiraConfigValidationError);
    await expect(updateSyncSettings(5, 8, { sync_enabled: "on" })).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reports a missing config instead of creating one", async () => {
    mockQuery.mockResolvedValue([[], 0]);

    await expect(updateSyncSettings(5, 8, { sync_interval_hours: 6 })).rejects.toBeInstanceOf(
      JiraNotConfiguredError,
    );
  });
});

describe("updateSelection (partial patch)", () => {
  it("changes only the selection fields that were sent, clearing on null", async () => {
    mockQuery.mockResolvedValue([[{ selected_schema_id: "3", selected_object_type_id: null }], 1]);

    await updateSelection(5, 8, { selected_schema_id: "3", selected_object_type_id: null });

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/sync_enabled|sync_interval|jira_base_url|api_token|email/);
    expect(options.replacements).toEqual({
      setSchema: true,
      schemaId: "3",
      setObjectType: true,
      objectTypeId: null,
      userId: 8,
      organizationId: 5,
    });
  });

  it("leaves a field that was not sent unchanged", async () => {
    mockQuery.mockResolvedValue([[{ selected_schema_id: "3", selected_object_type_id: "42" }], 1]);

    await updateSelection(5, 8, { selected_object_type_id: 42 });

    expect(mockQuery.mock.calls[0][1].replacements).toMatchObject({
      setSchema: false,
      setObjectType: true,
      objectTypeId: "42",
    });
  });

  it("rejects bad ids and empty bodies, and reports a missing config", async () => {
    await expect(updateSelection(5, 8, {})).rejects.toBeInstanceOf(JiraConfigValidationError);
    await expect(
      updateSelection(5, 8, { selected_object_type_id: "1; DROP TABLE x" }),
    ).rejects.toBeInstanceOf(JiraConfigValidationError);
    mockQuery.mockResolvedValue([[], 0]);
    await expect(updateSelection(5, 8, { selected_schema_id: "3" })).rejects.toBeInstanceOf(
      JiraNotConfiguredError,
    );
  });
});

describe("parseSyncIntervalHours", () => {
  it("defaults to 24 when missing", () => {
    expect(parseSyncIntervalHours(undefined)).toBe(24);
    expect(parseSyncIntervalHours(null)).toBe(24);
    expect(parseSyncIntervalHours("")).toBe(24);
  });

  it("accepts whole hours from 1 to 168, as numbers or numeric strings", () => {
    expect(parseSyncIntervalHours(1)).toBe(1);
    expect(parseSyncIntervalHours(168)).toBe(168);
    expect(parseSyncIntervalHours("6")).toBe(6);
  });

  it.each([0, 169, -5, 1.5, "abc", "12h", true, {}])("rejects %p", (raw) => {
    expect(() => parseSyncIntervalHours(raw)).toThrow(JiraConfigValidationError);
  });
});

describe("saveConfig validation", () => {
  const base = {
    jira_base_url: "https://x.atlassian.net",
    workspace_id: "w",
    email: "a@b.co",
  };

  it("rejects an out-of-range interval before writing", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]);

    await expect(saveConfig(5, 3, { ...base, sync_interval_hours: 500 })).rejects.toBeInstanceOf(
      JiraConfigValidationError,
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("saves a valid interval", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]).mockResolvedValue([]);

    await saveConfig(5, 3, { ...base, sync_enabled: true, sync_interval_hours: 6 });

    const update = mockQuery.mock.calls[1];
    expect(update[1].replacements).toMatchObject({ syncEnabled: true, syncIntervalHours: 6 });
  });
});
