import {
  claimSyncRun,
  JiraConfigValidationError,
  JiraSyncInProgressError,
  parseSyncIntervalHours,
  saveConfig,
  SYNC_STALE_AFTER_MS,
  syncObjects,
} from "../jiraAssets.service";
import { sequelize } from "../../../database/db";
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
  decryptText: jest.fn(() => ({ success: true, data: "token" })),
}));
jest.mock("../jira.client", () => ({
  JiraAssetsClient: jest.fn(),
}));

const mockQuery = sequelize.query as jest.Mock;
const mockTransaction = sequelize.transaction as unknown as jest.Mock;
const MockClient = JiraAssetsClient as unknown as jest.Mock;

const STARTED_AT = new Date("2026-10-12T12:00:00Z");

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset also drops queued *Once values a refused claim leaves unused.
  mockQuery.mockReset();
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX));
});

/** Queue the four queries claimSyncRun issues, with `running` as the in-flight check result. */
function queueClaimQueries(running: Array<{ id: number }>, newId = 99) {
  mockQuery
    .mockResolvedValueOnce([{}]) // advisory lock
    .mockResolvedValueOnce([[], 0]) // stale cleanup
    .mockResolvedValueOnce(running) // running check
    .mockResolvedValueOnce([[{ id: newId }], 1]); // insert
}

describe("claimSyncRun (overlap guard)", () => {
  it("records a new run when nothing is running", async () => {
    queueClaimQueries([]);

    const id = await claimSyncRun(5, "scheduled", null, STARTED_AT);

    expect(id).toBe(99);
    const sqls = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(sqls[0]).toContain("pg_advisory_xact_lock");
    expect(sqls[3]).toContain("INSERT INTO jira_assets_sync_history");
    expect(mockQuery.mock.calls[3][1].replacements).toEqual({
      organizationId: 5,
      syncType: "scheduled",
      startedAt: STARTED_AT,
      triggeredBy: null,
    });
    // Every statement runs inside the claim transaction.
    for (const [, options] of mockQuery.mock.calls) {
      expect(options.transaction).toBe(FAKE_TX);
    }
  });

  it("refuses when a sync is already running and inserts nothing", async () => {
    queueClaimQueries([{ id: 12 }]);

    await expect(claimSyncRun(5, "manual", 3, STARTED_AT)).rejects.toBeInstanceOf(
      JiraSyncInProgressError,
    );
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT"))).toBe(false);
  });

  it("closes runs stuck past the stale window before checking", async () => {
    queueClaimQueries([]);

    await claimSyncRun(5, "manual", 3, STARTED_AT);

    const [sql, options] = mockQuery.mock.calls[1];
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("status = 'started'");
    expect(options.replacements.organizationId).toBe(5);
    expect(options.replacements.staleBefore).toEqual(
      new Date(STARTED_AT.getTime() - SYNC_STALE_AFTER_MS),
    );
  });
});

describe("syncObjects", () => {
  it("does not call Jira when another sync holds the org", async () => {
    const getObjects = jest.fn();
    MockClient.mockImplementation(() => ({ getObjects }));
    mockQuery.mockResolvedValueOnce([
      {
        jira_base_url: "https://x.atlassian.net",
        workspace_id: "w",
        email: "a@b.co",
        api_token_encrypted: "enc",
        api_token_iv: "iv",
        selected_object_type_id: "42",
      },
    ]);
    queueClaimQueries([{ id: 1 }]);

    await expect(syncObjects(5, null, "scheduled")).rejects.toBeInstanceOf(JiraSyncInProgressError);
    expect(getObjects).not.toHaveBeenCalled();
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
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the existing-row lookup
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
