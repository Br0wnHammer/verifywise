import {
  evaluateScheduledSync,
  getScheduledSyncCandidates,
  JiraScheduledSyncState,
  runJiraAssetsScheduledSyncAllOrgs,
} from "../jiraAssets.scheduler";
import { SQL_NOW_UTC, sqlIntervalElapsed, sqlWithinLastMinutes } from "../../scheduledSync.utils";
import { sequelize } from "../../../database/db";
import { JiraSyncInProgressError, syncObjects } from "../jiraAssets.service";

jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
  logStructured: jest.fn(),
}));
jest.mock("../jiraAssets.service", () => {
  class MockInProgress extends Error {}
  return {
    syncObjects: jest.fn(),
    JiraSyncInProgressError: MockInProgress,
    SQL_RUN_IS_LIVE: "(LIVE_CHECK)",
  };
});

const mockQuery = sequelize.query as jest.Mock;
const mockSync = syncObjects as jest.Mock;

const candidate = (overrides: Partial<JiraScheduledSyncState> = {}): JiraScheduledSyncState => ({
  organization_id: 1,
  has_object_type: true,
  has_use_cases: true,
  running_is_live: false,
  is_due: true,
  ...overrides,
});

const okResult = {
  success: true,
  objectsFetched: 3,
  objectsCreated: 0,
  objectsUpdated: 3,
  objectsDeleted: 0,
  linksRemoved: 0,
  objectsMissingInJira: 0,
  missingInJiraIds: [],
  syncedAt: "2026-10-12T12:00:00.000Z",
  status: "success",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockSync.mockReset();
});

describe("scheduledSync SQL building blocks", () => {
  it("compares against NOW() in UTC, never a JS date", () => {
    expect(SQL_NOW_UTC).toBe("(NOW() AT TIME ZONE 'UTC')");
    expect(sqlIntervalElapsed("t.last", "t.hours")).toBe(
      "(t.last IS NULL OR t.last + make_interval(hours => t.hours) <= (NOW() AT TIME ZONE 'UTC'))",
    );
    expect(sqlWithinLastMinutes("t.beat", 15)).toBe(
      "(t.beat >= (NOW() AT TIME ZONE 'UTC') - make_interval(mins => 15))",
    );
  });

  it("refuses a non-integer minute count (it is interpolated)", () => {
    expect(() => sqlWithinLastMinutes("t.beat", 1.5)).toThrow();
    expect(() => sqlWithinLastMinutes("t.beat", -1)).toThrow();
  });
});

describe("evaluateScheduledSync", () => {
  it("is due when SQL says the interval has passed and nothing is running", () => {
    expect(evaluateScheduledSync(candidate())).toBe("due");
  });

  it("is not due when SQL says the interval has not passed", () => {
    expect(evaluateScheduledSync(candidate({ is_due: false }))).toBe("not_due");
  });

  it("waits while a run is live", () => {
    expect(evaluateScheduledSync(candidate({ running_is_live: true }))).toBe("running");
  });

  it("skips orgs without a selected object type", () => {
    expect(evaluateScheduledSync(candidate({ has_object_type: false }))).toBe("no_object_type");
  });

  it("skips orgs with nothing imported (nothing to refresh)", () => {
    expect(evaluateScheduledSync(candidate({ has_use_cases: false }))).toBe("no_use_cases");
  });
});

describe("getScheduledSyncCandidates", () => {
  it("only returns orgs with sync on and the extension enabled, with due/live decided in SQL", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await getScheduledSyncCandidates();

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("WHERE c.sync_enabled = TRUE");
    expect(sql).toContain("JOIN extensions e ON e.key = 'jira-assets'");
    expect(sql).toMatch(/JOIN extension_enablements ee[\s\S]*ee\.enabled = TRUE/);
    expect(sql).toContain("ee.organization_id = c.organization_id");
    // Every subquery is correlated on the candidate's own organization.
    expect(sql.match(/h\.organization_id = c\.organization_id/g)).toHaveLength(2);
    expect(sql).toContain("u.organization_id = c.organization_id");
    // Imports do not reset the refresh interval.
    expect(sql).toContain("h.sync_type IN ('manual', 'scheduled')");
    expect(sql).toContain("(LIVE_CHECK)) AS running_is_live");
    expect(sql).toMatch(/CROSS JOIN LATERAL[\s\S]*GREATEST\(\s*c\.last_sync_at/);
    expect(sql).toContain(
      "(lr.last_run IS NULL OR lr.last_run + make_interval(hours => c.sync_interval_hours) <= (NOW() AT TIME ZONE 'UTC')) AS is_due",
    );
  });
});

describe("runJiraAssetsScheduledSyncAllOrgs", () => {
  it("syncs only due candidates, as a scheduled run with no user", async () => {
    mockQuery.mockResolvedValueOnce([
      candidate({ organization_id: 1 }),
      candidate({ organization_id: 2, is_due: false }),
      candidate({ organization_id: 3, has_use_cases: false }),
      candidate({ organization_id: 4, running_is_live: true }),
    ]);
    mockSync.mockResolvedValue(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith(1, null, "scheduled");
    expect(summary).toEqual({ candidates: 4, synced: 1, failed: 0, skippedRunning: 1 });
  });

  it("skips an org whose sync started meanwhile and carries on", async () => {
    mockQuery.mockResolvedValueOnce([
      candidate({ organization_id: 1 }),
      candidate({ organization_id: 2 }),
    ]);
    mockSync.mockRejectedValueOnce(new JiraSyncInProgressError()).mockResolvedValueOnce(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs();

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ candidates: 2, synced: 1, failed: 0, skippedRunning: 1 });
  });

  it("does not let one org's failure stop the others", async () => {
    mockQuery.mockResolvedValueOnce([
      candidate({ organization_id: 1 }),
      candidate({ organization_id: 2 }),
      candidate({ organization_id: 3 }),
    ]);
    mockSync
      .mockRejectedValueOnce(new Error("unexpected"))
      .mockResolvedValueOnce({ ...okResult, success: false, status: "failed: 401" })
      .mockResolvedValueOnce(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs();

    expect(mockSync).toHaveBeenCalledTimes(3);
    expect(mockSync).toHaveBeenLastCalledWith(3, null, "scheduled");
    expect(summary).toEqual({ candidates: 3, synced: 1, failed: 2, skippedRunning: 0 });
  });
});
