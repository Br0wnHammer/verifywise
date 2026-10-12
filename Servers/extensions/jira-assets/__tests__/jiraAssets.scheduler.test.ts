import {
  evaluateScheduledSync,
  getScheduledSyncCandidates,
  JiraScheduledSyncState,
  runJiraAssetsScheduledSyncAllOrgs,
} from "../jiraAssets.scheduler";
import { isIntervalElapsed, latestDate } from "../../scheduledSync.utils";
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
    SYNC_STALE_AFTER_MS: 15 * 60 * 1000,
  };
});

const mockQuery = sequelize.query as jest.Mock;
const mockSync = syncObjects as jest.Mock;

const NOW = new Date("2026-10-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

const dueState = (overrides: Partial<JiraScheduledSyncState> = {}): JiraScheduledSyncState => ({
  organization_id: 1,
  sync_enabled: true,
  sync_interval_hours: 24,
  selected_object_type_id: "42",
  has_use_cases: true,
  last_sync_at: null,
  last_started_at: null,
  running_heartbeat_at: null,
  ...overrides,
});

const okResult = {
  success: true,
  objectsFetched: 3,
  objectsCreated: 0,
  objectsUpdated: 3,
  objectsDeleted: 0,
  objectsMissingInJira: 0,
  missingInJiraIds: [],
  syncedAt: NOW.toISOString(),
  status: "success",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockSync.mockReset();
});

describe("isIntervalElapsed", () => {
  it("is due when there has never been a run", () => {
    expect(isIntervalElapsed(null, 24, NOW)).toBe(true);
  });

  it("is due exactly at the interval boundary", () => {
    expect(isIntervalElapsed(hoursAgo(6), 6, NOW)).toBe(true);
  });

  it("is not due before the interval has passed", () => {
    expect(isIntervalElapsed(hoursAgo(5.9), 6, NOW)).toBe(false);
  });

  it.each([0, -1, NaN, Infinity])("is never due for a bad interval (%p)", (interval) => {
    expect(isIntervalElapsed(null, interval, NOW)).toBe(false);
  });
});

describe("latestDate", () => {
  it("picks the later timestamp and skips null and invalid values", () => {
    expect(latestDate(null, hoursAgo(3), "not a date", hoursAgo(1).toISOString())).toEqual(
      hoursAgo(1),
    );
    expect(latestDate(null, undefined)).toBeNull();
  });
});

describe("evaluateScheduledSync", () => {
  it("is due for an org that has never synced", () => {
    expect(evaluateScheduledSync(dueState(), NOW)).toBe("due");
  });

  it("is due once the interval has passed since the last sync", () => {
    expect(
      evaluateScheduledSync(
        dueState({ last_sync_at: hoursAgo(25), last_started_at: hoursAgo(25.1) }),
        NOW,
      ),
    ).toBe("due");
  });

  it("is not due inside the interval", () => {
    expect(evaluateScheduledSync(dueState({ last_sync_at: hoursAgo(2) }), NOW)).toBe("not_due");
  });

  it("counts from the later of last start and last finish", () => {
    expect(
      evaluateScheduledSync(
        dueState({ last_sync_at: hoursAgo(48), last_started_at: hoursAgo(1) }),
        NOW,
      ),
    ).toBe("not_due");
  });

  it("accepts timestamps as strings", () => {
    expect(evaluateScheduledSync(dueState({ last_sync_at: hoursAgo(30).toISOString() }), NOW)).toBe(
      "due",
    );
  });

  it("skips while a run has a fresh heartbeat", () => {
    expect(
      evaluateScheduledSync(
        dueState({ last_sync_at: hoursAgo(48), running_heartbeat_at: minutesAgo(5) }),
        NOW,
      ),
    ).toBe("running");
  });

  it("does not wait on a run whose heartbeat is older than 15 minutes", () => {
    expect(
      evaluateScheduledSync(
        dueState({ last_sync_at: hoursAgo(48), running_heartbeat_at: minutesAgo(16) }),
        NOW,
      ),
    ).toBe("due");
  });

  it("skips orgs with automatic sync switched off", () => {
    expect(evaluateScheduledSync(dueState({ sync_enabled: false }), NOW)).toBe("sync_disabled");
  });

  it("skips orgs without a selected object type", () => {
    expect(evaluateScheduledSync(dueState({ selected_object_type_id: null }), NOW)).toBe(
      "no_object_type",
    );
  });

  it("skips orgs with nothing imported (nothing to refresh)", () => {
    expect(evaluateScheduledSync(dueState({ has_use_cases: false }), NOW)).toBe("no_use_cases");
  });
});

describe("getScheduledSyncCandidates", () => {
  it("only returns orgs with sync on and the jira-assets extension enabled", async () => {
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
    expect(sql).toContain("COALESCE(h.heartbeat_at, h.started_at)");
  });
});

describe("runJiraAssetsScheduledSyncAllOrgs", () => {
  it("syncs only due candidates, as a scheduled run with no user", async () => {
    mockQuery.mockResolvedValueOnce([
      dueState({ organization_id: 1 }),
      dueState({ organization_id: 2, last_sync_at: hoursAgo(1) }), // not due
      dueState({ organization_id: 3, has_use_cases: false }), // nothing to refresh
      dueState({ organization_id: 4, running_heartbeat_at: minutesAgo(1) }), // running
    ]);
    mockSync.mockResolvedValue(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith(1, null, "scheduled");
    expect(summary).toEqual({ candidates: 4, synced: 1, failed: 0, skippedRunning: 1 });
  });

  it("skips an org whose sync started meanwhile and carries on", async () => {
    mockQuery.mockResolvedValueOnce([
      dueState({ organization_id: 1 }),
      dueState({ organization_id: 2 }),
    ]);
    mockSync.mockRejectedValueOnce(new JiraSyncInProgressError()).mockResolvedValueOnce(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ candidates: 2, synced: 1, failed: 0, skippedRunning: 1 });
  });

  it("does not let one org's failure stop the others", async () => {
    mockQuery.mockResolvedValueOnce([
      dueState({ organization_id: 1 }),
      dueState({ organization_id: 2 }),
      dueState({ organization_id: 3 }),
    ]);
    mockSync
      .mockRejectedValueOnce(new Error("unexpected"))
      .mockResolvedValueOnce({ ...okResult, success: false, status: "failed: 401" })
      .mockResolvedValueOnce(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockSync).toHaveBeenCalledTimes(3);
    expect(mockSync).toHaveBeenLastCalledWith(3, null, "scheduled");
    expect(summary).toEqual({ candidates: 3, synced: 1, failed: 2, skippedRunning: 0 });
  });
});
