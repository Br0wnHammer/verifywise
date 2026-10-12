import {
  claimSyncRun,
  errorMessage,
  finalizeFailure,
  getSyncStatus,
  importObjects,
  JiraImportInterruptedError,
  JiraConfigValidationError,
  JiraNotConfiguredError,
  JiraSyncInProgressError,
  parseSyncIntervalHours,
  runClaimedSync,
  runQueuedManualSync,
  saveConfig,
  startManualSync,
  SQL_RUN_IS_LIVE,
  syncObjects,
  touchHeartbeat,
  RunSupersededError,
  updateSelection,
  updateSyncSettings,
} from "../jiraAssets.service";
import { sequelize } from "../../../database/db";
import { decryptText } from "../../../tools/createSecureValue";
import { JiraAssetsClient } from "../jira.client";
import { enqueueJiraAssetsManualSync } from "../../../services/automations/automationProducer";
import logger from "../../../utils/logger/fileLogger";

const FAKE_TX = { id: "tx" };

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
jest.mock("../../../services/automations/automationProducer", () => ({
  enqueueJiraAssetsManualSync: jest.fn(),
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
const mockEnqueue = enqueueJiraAssetsManualSync as jest.Mock;

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

const jiraObject = (id: string, typeId = "42") => ({
  id,
  objectKey: `AI-${id}`,
  label: `System ${id}`,
  objectType: { id: typeId, name: "AI System" },
  attributes: [],
  created: "2026-01-01",
  updated: "2026-01-02",
});

const link = (id: string, projectId: number | null, typeId: string | null = "42") => ({
  jira_object_id: id,
  project_id: projectId,
  data: typeId === null ? { label: "no type" } : { objectType: { id: typeId } },
});

interface FakeDb {
  config?: Record<string, unknown> | null;
  existing?: Array<ReturnType<typeof link>>;
  running?: Array<{ id: number }>;
  /** Rows a heartbeat UPDATE affects; [] means another claim closed the run. */
  heartbeat?: Array<{ id: number }>;
  /** Rows the run's own finalize UPDATE affects. */
  ownRow?: Array<{ id: number }>;
  deletedProjects?: Array<{ id: number }>;
}

/** Route sequelize.query by SQL text, so tests read as scenarios, not call orders. */
function fakeDb({
  config = CONFIG_ROW,
  existing = [],
  running = [],
  heartbeat = [{ id: 77 }],
  ownRow = [{ id: 77 }],
  deletedProjects = [{ id: 1 }],
}: FakeDb = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) return [{}];
    if (sql.includes("marked as abandoned")) return [[], 0];
    if (sql.includes("SELECT id FROM jira_assets_sync_history")) return running;
    if (sql.includes("INSERT INTO jira_assets_sync_history")) return [[{ id: 77 }], 1];
    if (sql.includes("SET heartbeat_at")) return [heartbeat, {}];
    if (sql.includes("SELECT id, jira_base_url")) return config ? [config] : [];
    if (sql.includes("SELECT * FROM jira_assets_config")) return config ? [config] : [];
    if (sql.includes("SELECT jira_object_id, project_id, data")) return existing;
    if (sql.includes("SELECT id FROM jira_assets_use_cases")) return [];
    if (sql.includes("nextval")) return [{ seq: "9" }];
    if (sql.includes("INSERT INTO projects")) return [[{ id: 500 }], 1];
    if (sql.includes("SET status = 'completed'")) return [ownRow, {}];
    if (sql.includes("SET status = 'failed', error_message")) return [ownRow, {}];
    if (sql.includes("DELETE FROM projects")) return [deletedProjects, {}];
    if (sql.includes("DELETE FROM jira_assets_use_cases")) return [[{ id: 3 }], {}];
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
  mockEnqueue.mockResolvedValue({ id: "job" });
});

describe("claimSyncRun (overlap guard)", () => {
  it("records a new run with start and heartbeat set in SQL", async () => {
    fakeDb();

    const id = await claimSyncRun(5, "scheduled", null);

    expect(id).toBe(77);
    const [insertSql, insertOptions] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insertSql).toContain("(NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')");
    expect(insertOptions.replacements).toEqual({
      organizationId: 5,
      syncType: "scheduled",
      triggeredBy: null,
    });
    for (const [, options] of mockQuery.mock.calls) {
      expect(options.transaction).toBe(FAKE_TX);
    }
  });

  it("refuses when a run is already going and inserts nothing", async () => {
    fakeDb({ running: [{ id: 12 }] });

    await expect(claimSyncRun(5, "manual", 3)).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("decides staleness in SQL: no heartbeat for 15 minutes", async () => {
    fakeDb();

    await claimSyncRun(5, "import", 3);

    const [sql, options] = sqlCalls("marked as abandoned")[0];
    expect(sql).toContain(`NOT ${SQL_RUN_IS_LIVE}`);
    expect(SQL_RUN_IS_LIVE).toBe(
      "(COALESCE(h.heartbeat_at, h.started_at) >= (NOW() AT TIME ZONE 'UTC') - make_interval(mins => 15))",
    );
    expect(options.replacements).toEqual({ organizationId: 5 });
  });
});

describe("touchHeartbeat", () => {
  it("throws RunSupersededError when the row is no longer started", async () => {
    fakeDb({ heartbeat: [] });

    await expect(touchHeartbeat(77, 5)).rejects.toBeInstanceOf(RunSupersededError);
  });

  it("tolerates a database error (a missed heartbeat is not fatal)", async () => {
    mockQuery.mockRejectedValue(new Error("db hiccup"));

    await expect(touchHeartbeat(77, 5)).resolves.toBeUndefined();
  });
});

describe("runClaimedSync — scheduled (refresh-only)", () => {
  it("updates linked use cases and never creates or deletes", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    // "1" still in Jira, "3" is new upstream, "2" has gone from Jira.
    clientReturning([jiraObject("1"), jiraObject("3")]);

    const result = await syncObjects(5, null, "scheduled");

    expect(result.success).toBe(true);
    expect(result.objectsUpdated).toBe(1);
    expect(result.objectsCreated).toBe(0);
    expect(result.objectsDeleted).toBe(0);
    expect(result.missingInJiraIds).toEqual(["2"]);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements.note).toContain("missing in Jira");
  });

  it("records the run as scheduled with no user", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);

    await syncObjects(5, null, "scheduled");

    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "scheduled", triggeredBy: null });
  });
});

describe("runClaimedSync — abandoned runs stop", () => {
  it("writes nothing once another claim has closed the run", async () => {
    fakeDb({ existing: [link("1", 101)], heartbeat: [] });
    const getAllObjects = clientReturning([jiraObject("1")]);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("closed by another run");
    expect(getAllObjects).not.toHaveBeenCalled();
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
    expect(sqlCalls("SET status = 'failed'")).toHaveLength(0);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("leaves the config alone when its own row was already closed at finish", async () => {
    fakeDb({ existing: [link("1", 101)], ownRow: [] });
    clientReturning([jiraObject("1")]);

    const result = await runClaimedSync(5, 77, null, "scheduled");

    expect(result.success).toBe(false);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });
});

describe("runClaimedSync — manual deletion safety", () => {
  it("creates new objects (owned by the user) and deletes missing ones after a complete fetch", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.objectsCreated).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(sqlCalls("INSERT INTO projects")[0][1].replacements.owner).toBe(8);
    expect(sqlCalls("DELETE FROM projects")[0][1].replacements).toEqual({
      projectId: 102,
      organizationId: 5,
    });
  });

  it("only counts a delete when a project row was actually removed", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)], deletedProjects: [] });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.objectsDeleted).toBe(0);
  });

  it("removes a link with no project and counts it separately", async () => {
    fakeDb({ existing: [link("1", 101), link("2", null)] });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.objectsDeleted).toBe(0);
    expect(result.linksRemoved).toBe(1);
    const [completedSql, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completedSql).toContain("links_removed = :linksRemoved");
    expect(completed.replacements).toMatchObject({ objectsDeleted: 0, linksRemoved: 1 });
    const [sql, options] = sqlCalls("DELETE FROM jira_assets_use_cases")[0];
    expect(sql).toContain("project_id IS NULL");
    expect(options.replacements).toEqual({ jiraObjectId: "2", organizationId: 5 });
  });

  it("fails without changing anything when Jira returns no objects but links exist", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("returned no objects");
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
  });

  it("fails without changing anything when the fetch deadline is hit", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1")], false, "deadline");

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("did not return every object within 10 minutes");
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("keeps missing objects when pagination did not confirm the last page", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1")], false);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.success).toBe(true);
    expect(result.deletesSkippedReason).toContain("last page");
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("keeps missing objects when links came from a different object type", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102, "7")] });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.deletesSkippedReason).toContain("different object type");
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("keeps missing objects when any link's object type is unknown", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102, null)] });
    clientReturning([jiraObject("1")], true);

    const result = await runClaimedSync(5, 77, 8, "manual");

    expect(result.deletesSkippedReason).toContain("skipped: type unknown");
    expect(sqlCalls("DELETE FROM")).toHaveLength(0);
  });

  it("creates the project and its link in one transaction", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    await runClaimedSync(5, 77, 8, "manual");

    expect(sqlCalls("INSERT INTO projects")[0][1].transaction).toBe(FAKE_TX);
    expect(sqlCalls("INSERT INTO jira_assets_use_cases")[0][1].transaction).toBe(FAKE_TX);
  });
});

describe("runClaimedSync — failures before Jira is reached", () => {
  it("records a token decrypt failure on the history row and the config", async () => {
    fakeDb({ existing: [link("1", 101)] });
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    const result = await runClaimedSync(5, 77, null, "scheduled");

    expect(result.success).toBe(false);
    expect(result.status).toContain("bad key");
    const [, history] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(history.replacements).toMatchObject({ id: 77, organizationId: 5 });
    const [configSql, config] = sqlCalls("last_sync_status = 'failed'")[0];
    expect(configSql).toContain("last_sync_at = (NOW() AT TIME ZONE 'UTC')");
    expect(config.replacements.message).toContain("bad key");
  });
});

describe("startManualSync (Sync now runs in the worker)", () => {
  it("claims the run, queues it and returns the history id", async () => {
    fakeDb();

    await expect(startManualSync(5, 8)).resolves.toEqual({ historyId: 77 });
    expect(mockEnqueue).toHaveBeenCalledWith({ organizationId: 5, historyId: 77, triggeredBy: 8 });
  });

  it("rejects without a config or an object type, before claiming", async () => {
    fakeDb({ config: null });
    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraNotConfiguredError);

    fakeDb({ config: { ...CONFIG_ROW, selected_object_type_id: null } });
    await expect(startManualSync(5, 8)).rejects.toBeInstanceOf(JiraConfigValidationError);
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("closes the claimed run as failed if it cannot be queued", async () => {
    fakeDb();
    mockEnqueue.mockRejectedValue(new Error("redis down"));

    await expect(startManualSync(5, 8)).rejects.toThrow("redis down");
    const [, failed] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(failed.replacements).toMatchObject({ id: 77, message: "redis down" });
  });

  it("the worker entry fails closed without a valid org and run id", async () => {
    await expect(runQueuedManualSync({ historyId: 1 })).rejects.toThrow("organizationId");
    await expect(runQueuedManualSync({ organizationId: 5 })).rejects.toThrow("historyId");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("falls back to no user when triggeredBy is invalid, and still runs", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")]);

    const result = await runQueuedManualSync({
      organizationId: 5,
      historyId: 77,
      triggeredBy: "nobody",
    });

    expect(result.success).toBe(true);
    expect(sqlCalls("INSERT INTO projects")[0][1].replacements.owner).toBeNull();
  });

  it("closes the claimed row as failed if the run throws unexpectedly", async () => {
    fakeDb({ existing: [link("1", 101)], heartbeat: [] });
    clientReturning([jiraObject("1")]);
    (logger.warn as jest.Mock).mockImplementationOnce(() => {
      throw new Error("logger broke");
    });

    await expect(
      runQueuedManualSync({ organizationId: 5, historyId: 77, triggeredBy: 8 }),
    ).rejects.toThrow("logger broke");
    const [, failed] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(failed.replacements).toMatchObject({
      id: 77,
      organizationId: 5,
      message: "Manual sync could not run: logger broke",
    });
  });
});

describe("finalizeFailure", () => {
  it("only closes its own row while it is still started", async () => {
    mockQuery.mockResolvedValue([[{ id: 77 }], {}]);

    await finalizeFailure(77, 5, new Error("boom"));

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain(
      "WHERE id = :id AND organization_id = :organizationId AND status = 'started'",
    );
    expect(options.replacements).toMatchObject({ id: 77, organizationId: 5, message: "boom" });
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(1);
  });

  it("skips the config update when its row was already closed", async () => {
    mockQuery.mockResolvedValue([[], {}]);

    await finalizeFailure(77, 5, new Error("boom"));

    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("can record on the history row only (imports)", async () => {
    mockQuery.mockResolvedValue([[{ id: 77 }], {}]);

    await finalizeFailure(77, 5, new Error("boom"), false);

    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });

  it("never throws when the database write fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));

    await expect(finalizeFailure(77, 5, new Error("boom"))).resolves.toBe("boom");
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

  it("records the import in the history and counts a unique violation as skipped", async () => {
    fakeDb();
    const getObjectById = jest.fn(async (id: string) => jiraObject(id));
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById,
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
    expect(sqlCalls("SET status = 'completed'")).toHaveLength(1);
    expect(sqlCalls("UPDATE jira_assets_config")).toHaveLength(0);
  });
});

describe("importObjects — interrupted", () => {
  it("reports how many objects were imported when another run took over", async () => {
    fakeDb({ ownRow: [] });
    MockClient.mockImplementation(() => ({
      getAttributes: jest.fn(async () => []),
      getObjectById: jest.fn(async (id: string) => jiraObject(id)),
    }));

    const err = await importObjects(5, 8, ["1", "2"]).catch((e) => e);

    expect(err).toBeInstanceOf(JiraImportInterruptedError);
    expect(err).toMatchObject({ imported: 2, skipped: 0 });
    expect(err.message).toContain("2 object(s) were imported");
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(0);
  });
});

describe("getSyncStatus", () => {
  it("returns the requested run, with liveness computed in SQL", async () => {
    mockQuery.mockResolvedValue([{ running: true, run: { id: 77 } }]);

    await getSyncStatus(5, 77);

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("h.id = :historyId");
    expect(sql).toContain(`(h.status = 'started' AND ${SQL_RUN_IS_LIVE}) AS is_live`);
    expect(sql).toContain("links_removed");
    expect(options.replacements).toEqual({ organizationId: 5, historyId: 77 });
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
