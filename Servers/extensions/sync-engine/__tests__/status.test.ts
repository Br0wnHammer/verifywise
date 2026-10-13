jest.mock("../../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));

import { sequelize } from "../../../database/db";
import { __resetSyncProvidersForTests, registerSyncProvider } from "../registry";
import { hasLiveRun, latestStatusRunId } from "../status";

const mockQuery = sequelize.query as jest.Mock;

beforeAll(() => {
  __resetSyncProvidersForTests();
  registerSyncProvider({
    key: "demo-ext",
    kinds: ["manual", "scheduled", "import"],
    scheduledKind: "scheduled",
    readiness: async () => ({ ready: true }),
    run: async () => ({ counts: {} }),
  });
});
beforeEach(() => mockQuery.mockReset());

describe("live run and previous run", () => {
  it("checks liveness for one extension and org in SQL", async () => {
    mockQuery.mockResolvedValue([{ live: true }]);
    await expect(hasLiveRun("demo-ext", 5)).resolves.toBe(true);
    const [sql, options] = mockQuery.mock.calls[0];
    expect(sql).toContain("live.extension_key = :key");
    expect(options.replacements).toEqual({ key: "demo-ext", orgId: 5 });
  });

  it("returns the newest run of a status kind, or null", async () => {
    mockQuery.mockResolvedValue([{ id: 40 }]);
    await expect(latestStatusRunId("demo-ext", 5)).resolves.toBe(40);
    expect(mockQuery.mock.calls[0][1].replacements).toEqual({
      orgId: 5,
      key: "demo-ext",
      kinds: ["scheduled", "manual"],
    });
    mockQuery.mockResolvedValue([]);
    await expect(latestStatusRunId("demo-ext", 5)).resolves.toBeNull();
  });
});
