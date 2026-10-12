import {
  claimSyncRun,
  errorMessage,
  finalizeFailure,
  importObjects,
  JiraConfigNotFoundError,
  JiraConfigValidationError,
  JiraSyncInProgressError,
  parseSyncIntervalHours,
  saveConfig,
  SYNC_STALE_AFTER_MS,
  syncObjects,
  updateSyncSettings,
} from "../jiraAssets.service";
import { sequelize } from "../../../database/db";
import { decryptText } from "../../../tools/createSecureValue";
import { JiraAssetsClient } from "../jira.client";

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
jest.mock("../jira.client", () => ({
  JiraAssetsClient: jest.fn(),
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

const STARTED_AT = new Date("2026-10-12T12:00:00Z");

const CONFIG_ROW = {
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

const link = (id: string, projectId: number, typeId = "42") => ({
  jira_object_id: id,
  project_id: projectId,
  data: { objectType: { id: typeId } },
});

interface FakeDb {
  config?: Record<string, unknown> | null;
  existing?: Array<ReturnType<typeof link>>;
  running?: Array<{ id: number }>;
}

/** Route sequelize.query by SQL text, so tests read as scenarios, not call orders. */
function fakeDb({ config = CONFIG_ROW, existing = [], running = [] }: FakeDb = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_advisory_xact_lock")) return [{}];
    if (sql.includes("marked as abandoned")) return [[], 0];
    if (sql.includes("SELECT id FROM jira_assets_sync_history")) return running;
    if (sql.includes("INSERT INTO jira_assets_sync_history")) return [[{ id: 77 }], 1];
    if (sql.includes("SELECT * FROM jira_assets_config")) return config ? [config] : [];
    if (sql.includes("SELECT jira_object_id, project_id, data")) return existing;
    if (sql.includes("SELECT id FROM jira_assets_use_cases")) return [];
    if (sql.includes("nextval")) return [{ seq: "9" }];
    if (sql.includes("INSERT INTO projects")) return [[{ id: 500 }], 1];
    if (sql.includes("SET status = 'completed'")) return [undefined, 1];
    return [[], 0];
  });
}

const sqlCalls = (fragment: string) =>
  mockQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));

function clientReturning(objects: ReturnType<typeof jiraObject>[], complete = true) {
  const getAllObjects = jest.fn(
    async (_typeId: string, options: { onPage?: () => Promise<void> } = {}) => {
      if (options.onPage) await options.onPage();
      return { objects, complete };
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
});

describe("claimSyncRun (overlap guard)", () => {
  it("records a new run, with a first heartbeat, when nothing is running", async () => {
    fakeDb();

    const id = await claimSyncRun(5, "scheduled", null, STARTED_AT);

    expect(id).toBe(77);
    const [insertSql, insertOptions] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insertSql).toContain("heartbeat_at");
    expect(insertOptions.replacements).toEqual({
      organizationId: 5,
      syncType: "scheduled",
      startedAt: STARTED_AT,
      triggeredBy: null,
    });
    for (const [, options] of mockQuery.mock.calls) {
      expect(options.transaction).toBe(FAKE_TX);
    }
  });

  it("refuses when a run is already going and inserts nothing", async () => {
    fakeDb({ running: [{ id: 12 }] });

    await expect(claimSyncRun(5, "manual", 3, STARTED_AT)).rejects.toBeInstanceOf(
      JiraSyncInProgressError,
    );
    expect(sqlCalls("INSERT INTO jira_assets_sync_history")).toHaveLength(0);
  });

  it("treats a run as stale only after 15 minutes without a heartbeat", async () => {
    fakeDb();

    await claimSyncRun(5, "import", 3, STARTED_AT);

    const [sql, options] = sqlCalls("marked as abandoned")[0];
    expect(sql).toContain("COALESCE(heartbeat_at, started_at) < :staleBefore");
    expect(SYNC_STALE_AFTER_MS).toBe(15 * 60 * 1000);
    expect(options.replacements.staleBefore).toEqual(
      new Date(STARTED_AT.getTime() - 15 * 60 * 1000),
    );
  });
});

describe("syncObjects — scheduled (refresh-only)", () => {
  it("updates linked use cases and never creates or deletes", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    // "1" still in Jira, "3" is new upstream, "2" has gone from Jira.
    clientReturning([jiraObject("1"), jiraObject("3")]);

    const result = await syncObjects(5, null, "scheduled");

    expect(result.success).toBe(true);
    expect(result.objectsUpdated).toBe(1);
    expect(result.objectsCreated).toBe(0);
    expect(result.objectsDeleted).toBe(0);
    expect(result.objectsMissingInJira).toBe(1);
    expect(result.missingInJiraIds).toEqual(["2"]);
    expect(sqlCalls("INSERT INTO projects")).toHaveLength(0);
    expect(sqlCalls("DELETE FROM projects")).toHaveLength(0);
    const [, completed] = sqlCalls("SET status = 'completed'")[0];
    expect(completed.replacements.note).toContain("missing in Jira");
    expect(completed.replacements.note).toContain(": 2");
  });

  it("records the run as scheduled with no user", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);

    await syncObjects(5, null, "scheduled");

    const [, insert] = sqlCalls("INSERT INTO jira_assets_sync_history")[0];
    expect(insert.replacements).toMatchObject({ syncType: "scheduled", triggeredBy: null });
  });

  it("writes a heartbeat while fetching", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1")]);

    await syncObjects(5, null, "scheduled");

    expect(sqlCalls("SET heartbeat_at = :now").length).toBeGreaterThan(0);
  });
});

describe("syncObjects — manual deletion safety", () => {
  it("creates new objects (owned by the user) and deletes missing ones after a complete fetch", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    const result = await syncObjects(5, 8, "manual");

    expect(result.objectsCreated).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(sqlCalls("INSERT INTO projects")[0][1].replacements.owner).toBe(8);
    expect(sqlCalls("DELETE FROM projects")[0][1].replacements).toEqual({
      projectId: 102,
      organizationId: 5,
    });
  });

  it("fails without changing anything when Jira returns no objects but links exist", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([], true);

    const result = await syncObjects(5, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("returned no objects");
    expect(sqlCalls("DELETE FROM projects")).toHaveLength(0);
    expect(sqlCalls("UPDATE projects")).toHaveLength(0);
    const [, failed] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(failed.replacements.id).toBe(77);
  });

  it("keeps missing objects when pagination did not confirm the last page", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102)] });
    clientReturning([jiraObject("1")], false);

    const result = await syncObjects(5, 8, "manual");

    expect(result.success).toBe(true);
    expect(result.objectsDeleted).toBe(0);
    expect(result.missingInJiraIds).toEqual(["2"]);
    expect(result.deletesSkippedReason).toContain("last page");
    expect(sqlCalls("DELETE FROM projects")).toHaveLength(0);
  });

  it("keeps missing objects when links came from a different object type", async () => {
    fakeDb({ existing: [link("1", 101), link("2", 102, "7")] });
    clientReturning([jiraObject("1")], true);

    const result = await syncObjects(5, 8, "manual");

    expect(result.objectsDeleted).toBe(0);
    expect(result.deletesSkippedReason).toContain("different object type");
    expect(sqlCalls("DELETE FROM projects")).toHaveLength(0);
  });

  it("creates the project and its link in one transaction", async () => {
    fakeDb({ existing: [link("1", 101)] });
    clientReturning([jiraObject("1"), jiraObject("3")], true);

    await syncObjects(5, 8, "manual");

    const [, projectInsert] = sqlCalls("INSERT INTO projects")[0];
    const [, linkInsert] = sqlCalls("INSERT INTO jira_assets_use_cases")[0];
    expect(projectInsert.transaction).toBe(FAKE_TX);
    expect(linkInsert.transaction).toBe(FAKE_TX);
  });

  it("does not call Jira when another run holds the org", async () => {
    fakeDb({ running: [{ id: 1 }] });
    const getAllObjects = clientReturning([jiraObject("1")]);

    await expect(syncObjects(5, null, "scheduled")).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(getAllObjects).not.toHaveBeenCalled();
  });
});

describe("syncObjects — failures before Jira is reached", () => {
  it("records a token decrypt failure on the history row and the config", async () => {
    fakeDb({ existing: [link("1", 101)] });
    mockDecrypt.mockReturnValue({ success: false, error: "bad key" });

    const result = await syncObjects(5, null, "scheduled");

    expect(result.success).toBe(false);
    expect(result.status).toContain("bad key");
    const [, history] = sqlCalls("SET status = 'failed', error_message")[0];
    expect(history.replacements).toMatchObject({ id: 77, organizationId: 5 });
    const [configSql, config] = sqlCalls("last_sync_status = 'failed'")[0];
    expect(configSql).toContain("last_sync_at = :now");
    expect(config.replacements.message).toContain("bad key");
  });

  it("records a missing config as a failed run", async () => {
    fakeDb({ config: null });

    const result = await syncObjects(5, 8, "manual");

    expect(result.success).toBe(false);
    expect(result.status).toContain("JIRA not configured");
    expect(sqlCalls("SET status = 'failed', error_message")).toHaveLength(1);
  });
});

describe("finalizeFailure", () => {
  it("only closes its own row while it is still started", async () => {
    mockQuery.mockResolvedValue([[], 0]);

    await finalizeFailure(77, 5, new Error("boom"));

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain(
      "WHERE id = :id AND organization_id = :organizationId AND status = 'started'",
    );
    expect(options.replacements).toMatchObject({ id: 77, organizationId: 5, message: "boom" });
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
  });
});

describe("updateSyncSettings (partial patch)", () => {
  it("updates only the sync fields that were sent", async () => {
    mockQuery.mockResolvedValue([[{ sync_enabled: true, sync_interval_hours: 24 }], 1]);

    const result = await updateSyncSettings(5, 8, { sync_enabled: true });

    expect(result).toEqual({ sync_enabled: true, sync_interval_hours: 24 });
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("COALESCE(:syncEnabled, sync_enabled)");
    expect(sql).toContain("COALESCE(:syncIntervalHours, sync_interval_hours)");
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
      JiraConfigNotFoundError,
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

  it("rejects a non-boolean sync_enabled", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]);

    await expect(
      saveConfig(5, 3, { ...base, sync_enabled: "yes" as unknown as boolean }),
    ).rejects.toBeInstanceOf(JiraConfigValidationError);
  });

  it("saves a valid interval", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 1, api_token_encrypted: "enc" }]).mockResolvedValue([]);

    await saveConfig(5, 3, { ...base, sync_enabled: true, sync_interval_hours: 6 });

    const update = mockQuery.mock.calls[1];
    expect(update[0]).toContain("UPDATE jira_assets_config");
    expect(update[1].replacements).toMatchObject({ syncEnabled: true, syncIntervalHours: 6 });
  });
});
