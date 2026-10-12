import {
  evaluateScheduledSync,
  JiraScheduledSyncState,
  runJiraAssetsScheduledSyncAllOrgs,
} from "../jiraAssets.scheduler";
import { isIntervalElapsed, latestDate } from "../../scheduledSync.utils";
import { sequelize } from "../../../database/db";
import { getAllOrganizationsQuery } from "../../../utils/organization.utils";
import { JiraSyncInProgressError, syncObjects } from "../jiraAssets.service";

jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock("../../../utils/organization.utils", () => ({
  getAllOrganizationsQuery: jest.fn(),
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
  };
});

const mockQuery = sequelize.query as jest.Mock;
const mockAllOrgs = getAllOrganizationsQuery as jest.Mock;
const mockSync = syncObjects as jest.Mock;

const NOW = new Date("2026-10-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

const dueState = (overrides: Partial<JiraScheduledSyncState> = {}): JiraScheduledSyncState => ({
  extension_enabled: true,
  has_config: true,
  sync_enabled: true,
  sync_interval_hours: 24,
  selected_object_type_id: "42",
  has_use_cases: true,
  last_sync_at: null,
  last_started_at: null,
  ...overrides,
});

const okResult = {
  success: true,
  objectsFetched: 3,
  objectsCreated: 1,
  objectsUpdated: 2,
  objectsDeleted: 0,
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
  it("is due for an enabled org that has never synced", () => {
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
    // Finished long ago, but a newer run started 1h ago (e.g. a manual sync).
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

  it("skips orgs where the extension is disabled, even with sync switched on", () => {
    expect(evaluateScheduledSync(dueState({ extension_enabled: false }), NOW)).toBe(
      "extension_disabled",
    );
  });

  it("skips orgs without a config", () => {
    expect(evaluateScheduledSync(dueState({ has_config: false }), NOW)).toBe("no_config");
  });

  it("skips orgs with automatic sync switched off", () => {
    expect(evaluateScheduledSync(dueState({ sync_enabled: false }), NOW)).toBe("sync_disabled");
  });

  it("skips orgs without a selected object type", () => {
    expect(evaluateScheduledSync(dueState({ selected_object_type_id: null }), NOW)).toBe(
      "no_object_type",
    );
  });

  it("skips orgs that have not imported anything yet", () => {
    expect(evaluateScheduledSync(dueState({ has_use_cases: false }), NOW)).toBe("no_use_cases");
  });
});

describe("runJiraAssetsScheduledSyncAllOrgs", () => {
  it("syncs only enabled, due orgs, as a scheduled run with no user", async () => {
    mockAllOrgs.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    mockQuery
      .mockResolvedValueOnce([dueState()]) // org 1: due
      .mockResolvedValueOnce([dueState({ extension_enabled: false })]) // org 2: extension off
      .mockResolvedValueOnce([]) // org 3: no config row
      .mockResolvedValueOnce([dueState({ last_sync_at: hoursAgo(1) })]); // org 4: not due
    mockSync.mockResolvedValue(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith(1, null, "scheduled");
    expect(summary).toEqual({ checked: 4, synced: 1, failed: 0, skippedRunning: 0 });
  });

  it("filters every state query by the org being checked", async () => {
    mockAllOrgs.mockResolvedValue([{ id: 7 }]);
    mockQuery.mockResolvedValueOnce([]);

    await runJiraAssetsScheduledSyncAllOrgs(NOW);

    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("COALESCE(ee.enabled, FALSE) AS extension_enabled");
    expect(sql).toContain("e.key = 'jira-assets'");
    expect(options.replacements).toEqual({ organizationId: 7 });
  });

  it("skips an org whose sync is already running and carries on", async () => {
    mockAllOrgs.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockQuery.mockResolvedValueOnce([dueState()]).mockResolvedValueOnce([dueState()]);
    mockSync.mockRejectedValueOnce(new JiraSyncInProgressError()).mockResolvedValueOnce(okResult);

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ checked: 2, synced: 1, failed: 0, skippedRunning: 1 });
  });

  it("does not let one org's failure stop the others", async () => {
    mockAllOrgs.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockQuery
      .mockRejectedValueOnce(new Error("db hiccup")) // org 1: state query throws
      .mockResolvedValueOnce([dueState()]) // org 2: sync throws
      .mockResolvedValueOnce([dueState()]); // org 3: fine
    mockSync
      .mockRejectedValueOnce(new Error("decrypt failed"))
      .mockResolvedValueOnce({ ...okResult, success: false, status: "failed: 401" });

    const summary = await runJiraAssetsScheduledSyncAllOrgs(NOW);

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenLastCalledWith(3, null, "scheduled");
    expect(summary).toEqual({ checked: 3, synced: 0, failed: 3, skippedRunning: 0 });
  });
});
