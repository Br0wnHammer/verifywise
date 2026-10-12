import { runDataRetentionPrune, runDataRetentionPruneAllOrgs } from "../dataRetentionPrune";
import { pruneAuditLedgerBatch } from "../../../../utils/auditLedgerRetention.utils";
import { appendToAuditLedger } from "../../../../utils/auditLedger.utils";
import {
  AUDIT_RECORD_TABLES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  auditTableExists,
  deleteAuditRowsBatch,
  getAuditCutoff,
  getAuditRetentionMonths,
  getGatewayAutoPurgeOrgIds,
  getOrgsWithAuditRetention,
  pruneRetentionRunHistory,
  safeRecordRetentionRun,
} from "../../../../utils/dataRetention.utils";
import { aiGatewayRequest } from "../../../../utils/aiGatewayInternal.utils";

jest.mock("../../../../utils/auditLedgerRetention.utils", () => ({
  pruneAuditLedgerBatch: jest.fn(),
}));
jest.mock("../../../../utils/auditLedger.utils", () => ({
  appendToAuditLedger: jest.fn(),
}));
jest.mock("../../../../utils/dataRetention.utils", () => ({
  ...jest.requireActual("../../../../utils/dataRetention.utils"),
  getAuditRetentionMonths: jest.fn(),
  getAuditCutoff: jest.fn(),
  deleteAuditRowsBatch: jest.fn(),
  safeRecordRetentionRun: jest.fn(),
  getGatewayAutoPurgeOrgIds: jest.fn(),
  getOrgsWithAuditRetention: jest.fn(),
  pruneRetentionRunHistory: jest.fn(),
  auditTableExists: jest.fn(),
}));
jest.mock("../../../../utils/aiGatewayInternal.utils", () => ({
  aiGatewayRequest: jest.fn(),
}));
jest.mock("../../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));

const mockMonths = getAuditRetentionMonths as jest.Mock;
const mockLedger = pruneAuditLedgerBatch as jest.Mock;
const mockTable = deleteAuditRowsBatch as jest.Mock;
const mockRecord = safeRecordRetentionRun as jest.Mock;
const mockAppend = appendToAuditLedger as jest.Mock;
const mockAllOrgs = getOrgsWithAuditRetention as jest.Mock;
const mockCutoff = getAuditCutoff as jest.Mock;
const mockExists = auditTableExists as jest.Mock;
const mockRunHistory = pruneRetentionRunHistory as jest.Mock;
const mockGateway = aiGatewayRequest as jest.Mock;
const mockOptedIn = getGatewayAutoPurgeOrgIds as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCutoff.mockResolvedValue("2024-06-10 00:00:00+00");
  mockMonths.mockResolvedValue(24);
  mockLedger.mockResolvedValue(0);
  mockTable.mockResolvedValue(0);
  mockGateway.mockResolvedValue({ results: [] });
  mockOptedIn.mockResolvedValue([]);
  mockAllOrgs.mockResolvedValue([]);
  mockExists.mockResolvedValue(true);
  mockRunHistory.mockResolvedValue(0);
});

describe("runDataRetentionPrune", () => {
  it("does nothing and records nothing when no period is set", async () => {
    mockMonths.mockResolvedValue(null);
    expect(await runDataRetentionPrune(1)).toBeNull();
    expect(mockLedger).not.toHaveBeenCalled();
    expect(mockTable).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("sums ledger and table deletions, records a success run and a self-audit entry", async () => {
    mockLedger.mockResolvedValueOnce(4);
    mockTable.mockResolvedValueOnce(3);
    const summary = await runDataRetentionPrune(1);
    expect(summary).toMatchObject({ deleted: 7, capped: false });
    expect(mockTable).toHaveBeenCalledTimes(AUDIT_RECORD_TABLES.length);
    expect(mockRecord).toHaveBeenCalledWith({
      organizationId: 1,
      recordType: "audit_records",
      cutoff: "2024-06-10 00:00:00+00",
      deletedCount: 7,
      status: "success",
      error: undefined,
    });
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 1,
        entryType: "event_log",
        userId: null,
        eventType: "Delete",
        entityType: "audit_ledger",
        description: "Retention removed 7 audit records before 2024-06-10",
      }),
    );
  });

  it("skips the self-audit entry when nothing was deleted", async () => {
    await runDataRetentionPrune(1);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ deletedCount: 0, status: "success" }),
    );
  });

  it("reports capped when the batch cap is hit", async () => {
    mockLedger.mockResolvedValue(RETENTION_BATCH_SIZE);
    const summary = await runDataRetentionPrune(1);
    expect(mockLedger).toHaveBeenCalledTimes(RETENTION_MAX_BATCHES);
    expect(summary?.capped).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ status: "capped" }));
  });

  it("keeps draining other tables when one fails and records a failed run naming it", async () => {
    mockLedger.mockResolvedValueOnce(4);
    mockTable.mockImplementation(async (_org: number, entry: { table: string }) => {
      if (entry.table === "project_change_history") throw new Error("column missing");
      return entry.table === "event_logs" ? 3 : 0;
    });
    const summary = await runDataRetentionPrune(1);
    expect(mockTable).toHaveBeenCalledTimes(AUDIT_RECORD_TABLES.length);
    expect(summary?.deleted).toBe(7);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        deletedCount: 7,
        error: expect.stringContaining("project_change_history: column missing"),
      }),
    );
    expect(mockAppend).toHaveBeenCalled();
  });

  it("isolates a ledger failure from the table drains", async () => {
    mockLedger.mockRejectedValueOnce(new Error("lock"));
    await runDataRetentionPrune(1);
    expect(mockTable).toHaveBeenCalledTimes(AUDIT_RECORD_TABLES.length);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: expect.stringContaining("audit_ledger") }),
    );
  });

  it("does not fail when the self-audit entry fails", async () => {
    mockLedger.mockResolvedValueOnce(2);
    mockAppend.mockRejectedValueOnce(new Error("ledger down"));
    await expect(runDataRetentionPrune(1)).resolves.toMatchObject({ deleted: 2 });
  });
});

describe("audit table existence", () => {
  it("skips a table that does not exist without deleting from it", async () => {
    mockExists.mockImplementation(async (entry: { table: string }) => entry.table !== "event_logs");
    await runDataRetentionPrune(1);
    expect(mockTable).toHaveBeenCalledTimes(AUDIT_RECORD_TABLES.length - 1);
    expect(mockTable).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ table: "event_logs" }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockTable).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ table: "vendor_change_history" }),
      "2024-06-10 00:00:00+00",
      RETENTION_BATCH_SIZE,
    );
  });

  it("checks each table once per run, not per batch or per org", async () => {
    mockAllOrgs.mockResolvedValue([
      { organizationId: 1, months: 12 },
      { organizationId: 2, months: 24 },
    ]);
    mockTable.mockImplementation(async (_org: number, entry: { table: string }) =>
      entry.table === "event_logs" && mockTable.mock.calls.length < 3 ? RETENTION_BATCH_SIZE : 0,
    );
    await runDataRetentionPruneAllOrgs();
    expect(mockExists).toHaveBeenCalledTimes(AUDIT_RECORD_TABLES.length);
  });

  it("records a failed run when the existence check fails, and retries it next time", async () => {
    mockExists.mockRejectedValueOnce(new Error("catalog down"));
    await runDataRetentionPrune(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("event_logs: catalog down"),
      }),
    );
  });
});

describe("runDataRetentionPruneAllOrgs", () => {
  it("reads every org's period in one query and isolates a failing org", async () => {
    mockAllOrgs.mockResolvedValue([
      { organizationId: 1, months: 12 },
      { organizationId: 2, months: 24 },
    ]);
    mockCutoff.mockRejectedValueOnce(new Error("boom"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockMonths).not.toHaveBeenCalled();
    expect(mockCutoff).toHaveBeenNthCalledWith(1, 12);
    expect(mockCutoff).toHaveBeenNthCalledWith(2, 24);
    expect(mockRecord).toHaveBeenCalledWith({
      organizationId: 1,
      recordType: "audit_records",
      cutoff: null,
      deletedCount: 0,
      status: "failed",
      error: expect.objectContaining({ message: "boom" }),
    });
    expect(mockLedger).toHaveBeenCalledTimes(1);
    expect(mockLedger).toHaveBeenCalledWith(2, "2024-06-10 00:00:00+00", RETENTION_BATCH_SIZE);
  });

  it("prunes run history once per run, after the orgs, and survives its failure", async () => {
    mockAllOrgs.mockResolvedValue([{ organizationId: 1, months: 12 }]);
    mockRunHistory.mockRejectedValueOnce(new Error("history down"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockRunHistory).toHaveBeenCalledTimes(1);
    expect(mockRunHistory.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockLedger.mock.invocationCallOrder[0],
    );
  });

  const purgeCall = (organizationId: number) => [
    "POST",
    "/internal/retention/purge",
    { body: { organization_id: organizationId }, timeoutMs: 300_000 },
  ];

  describe("when the gateway refuses the purge over the internal key", () => {
    const savedKey = process.env.AI_GATEWAY_INTERNAL_KEY;
    afterEach(() => {
      if (savedKey === undefined) delete process.env.AI_GATEWAY_INTERNAL_KEY;
      else process.env.AI_GATEWAY_INTERNAL_KEY = savedKey;
    });

    const refused = (status: number) =>
      Object.assign(new Error(`AI Gateway ${status}`), { status, body: {} });

    it.each([
      ["the gateway has no key (503)", 503, "set", "Purge refused: internal key not configured"],
      ["this backend has no key (401)", 401, "", "Purge refused: internal key not configured"],
      ["the keys differ (401)", 401, "set", "Purge refused: internal key rejected"],
    ])("records both log types as failed when %s", async (_case, status, key, message) => {
      process.env.AI_GATEWAY_INTERNAL_KEY = key === "set" ? "some-key" : "";
      mockOptedIn.mockResolvedValue([5]);
      mockGateway.mockRejectedValue(refused(status as number));

      await runDataRetentionPruneAllOrgs();

      for (const recordType of ["ai_gateway_guardrail_logs", "ai_gateway_spend_logs"]) {
        expect(mockRecord).toHaveBeenCalledWith(
          expect.objectContaining({
            organizationId: 5,
            recordType,
            status: "failed",
            deletedCount: 0,
            error: message,
          }),
        );
      }
    });

    it("keeps the original message for other gateway errors", async () => {
      process.env.AI_GATEWAY_INTERNAL_KEY = "some-key";
      mockOptedIn.mockResolvedValue([5]);
      mockGateway.mockRejectedValue(
        Object.assign(new Error("AI Gateway 500: boom"), { status: 500 }),
      );

      await runDataRetentionPruneAllOrgs();

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          recordType: "ai_gateway_guardrail_logs",
          status: "failed",
          error: "AI Gateway 500: boom",
        }),
      );
    });
  });

  it("calls the gateway purge once per opted-in org and records both log types", async () => {
    mockOptedIn.mockResolvedValue([5, 6]);
    mockGateway.mockImplementation(
      async (_m: string, _p: string, opts: { body: { organization_id: number } }) => {
        const id = opts.body.organization_id;
        return {
          results: [
            id === 5
              ? { organization_id: 5, guardrail_deleted: 3, spend_deleted: 9 }
              : {
                  organization_id: 6,
                  guardrail_deleted: 4,
                  spend_deleted: 0,
                  spend_error: "db down",
                },
          ],
        };
      },
    );
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(2);
    expect(mockGateway).toHaveBeenNthCalledWith(1, ...purgeCall(5));
    expect(mockGateway).toHaveBeenNthCalledWith(2, ...purgeCall(6));
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 5,
        recordType: "ai_gateway_guardrail_logs",
        deletedCount: 3,
        status: "success",
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 5,
        recordType: "ai_gateway_spend_logs",
        deletedCount: 9,
        status: "success",
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 6,
        recordType: "ai_gateway_spend_logs",
        status: "failed",
        error: "db down",
      }),
    );
    // The spend failure does not mark the guardrail purge failed.
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 6,
        recordType: "ai_gateway_guardrail_logs",
        deletedCount: 4,
        status: "success",
        error: undefined,
      }),
    );
  });

  it("repeats the call while a type is capped and sums the counts", async () => {
    mockOptedIn.mockResolvedValue([5]);
    mockGateway
      .mockResolvedValueOnce({
        results: [
          {
            organization_id: 5,
            guardrail_deleted: 100_000,
            guardrail_capped: true,
            spend_deleted: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [{ organization_id: 5, guardrail_deleted: 500, spend_deleted: 0 }],
      });
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(2);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 5,
        recordType: "ai_gateway_guardrail_logs",
        deletedCount: 100_500,
        status: "success",
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 5,
        recordType: "ai_gateway_spend_logs",
        deletedCount: 2,
        status: "success",
      }),
    );
  });

  it("stops after five calls and records capped when a type is still capped", async () => {
    mockOptedIn.mockResolvedValue([5]);
    mockGateway.mockResolvedValue({
      results: [
        { organization_id: 5, guardrail_deleted: 0, spend_deleted: 100_000, spend_capped: true },
      ],
    });
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(5);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: "ai_gateway_spend_logs",
        deletedCount: 500_000,
        status: "capped",
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: "ai_gateway_guardrail_logs", status: "success" }),
    );
  });

  it("records failed for a type that errored on any call, keeping deleted counts", async () => {
    mockOptedIn.mockResolvedValue([5]);
    mockGateway
      .mockResolvedValueOnce({
        results: [
          { organization_id: 5, guardrail_deleted: 7, spend_deleted: 100_000, spend_capped: true },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          { organization_id: 5, guardrail_deleted: 0, guardrail_error: "lock", spend_deleted: 10 },
        ],
      });
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(2);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: "ai_gateway_guardrail_logs",
        deletedCount: 7,
        status: "failed",
        error: "lock",
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: "ai_gateway_spend_logs",
        deletedCount: 100_010,
        status: "success",
      }),
    );
  });

  it("records failed runs for one org whose call fails without affecting the next org", async () => {
    mockOptedIn.mockResolvedValue([5, 6]);
    mockGateway.mockRejectedValueOnce(new Error("gateway timeout")).mockResolvedValueOnce({
      results: [{ organization_id: 6, guardrail_deleted: 1, spend_deleted: 2 }],
    });
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockGateway).toHaveBeenCalledTimes(2);
    for (const recordType of ["ai_gateway_guardrail_logs", "ai_gateway_spend_logs"]) {
      expect(mockRecord).toHaveBeenCalledWith({
        organizationId: 5,
        recordType,
        cutoff: null,
        deletedCount: 0,
        status: "failed",
        error: "gateway timeout",
      });
    }
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 6, status: "success", deletedCount: 2 }),
    );
  });

  it("records nothing for an org the gateway no longer reports (opted out since)", async () => {
    mockOptedIn.mockResolvedValue([5]);
    mockGateway.mockResolvedValue({ results: [] });
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("never fails the job when reading opted-in orgs fails", async () => {
    mockOptedIn.mockRejectedValue(new Error("db down"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockGateway).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
