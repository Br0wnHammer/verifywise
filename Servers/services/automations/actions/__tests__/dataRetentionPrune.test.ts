import { runDataRetentionPrune, runDataRetentionPruneAllOrgs } from "../dataRetentionPrune";
import { pruneAuditLedgerBatch } from "../../../../utils/auditLedgerRetention.utils";
import { appendToAuditLedger } from "../../../../utils/auditLedger.utils";
import {
  AUDIT_RECORD_TABLES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  deleteAuditRowsBatch,
  getAuditRetentionMonths,
  getGatewayAutoPurgeOrgIds,
  recordRetentionRun,
} from "../../../../utils/dataRetention.utils";
import { getAllOrganizationsQuery } from "../../../../utils/organization.utils";
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
  recordRetentionRun: jest.fn(),
  getGatewayAutoPurgeOrgIds: jest.fn(),
}));
jest.mock("../../../../utils/organization.utils", () => ({
  getAllOrganizationsQuery: jest.fn(),
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
const mockRecord = recordRetentionRun as jest.Mock;
const mockAppend = appendToAuditLedger as jest.Mock;
const mockAllOrgs = getAllOrganizationsQuery as jest.Mock;
const mockGateway = aiGatewayRequest as jest.Mock;
const mockOptedIn = getGatewayAutoPurgeOrgIds as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("../../../../utils/dataRetention.utils").getAuditCutoff as jest.Mock).mockResolvedValue(
    "2024-06-10 00:00:00+00",
  );
  mockMonths.mockResolvedValue(24);
  mockLedger.mockResolvedValue(0);
  mockTable.mockResolvedValue(0);
  mockGateway.mockResolvedValue({ results: [] });
  mockOptedIn.mockResolvedValue([]);
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
      error: null,
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

  it("does not fail when the self-audit entry or run recording fails", async () => {
    mockLedger.mockResolvedValueOnce(2);
    mockAppend.mockRejectedValueOnce(new Error("ledger down"));
    mockRecord.mockRejectedValueOnce(new Error("record down"));
    await expect(runDataRetentionPrune(1)).resolves.toMatchObject({ deleted: 2 });
  });
});

describe("runDataRetentionPruneAllOrgs", () => {
  it("isolates a failing org", async () => {
    mockAllOrgs.mockResolvedValue([{ id: 1 }, { id: undefined }, { id: 2 }]);
    mockMonths.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("boom");
      return 12;
    });
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockRecord).toHaveBeenCalledWith({
      organizationId: 1,
      recordType: "audit_records",
      cutoff: null,
      deletedCount: 0,
      status: "failed",
      error: "boom",
    });
    expect(mockLedger).toHaveBeenCalledTimes(1);
    expect(mockLedger).toHaveBeenCalledWith(2, "2024-06-10 00:00:00+00", RETENTION_BATCH_SIZE);
  });

  it("calls the gateway purge once, without org or role, and records both log types per org", async () => {
    mockAllOrgs.mockResolvedValue([]);
    mockGateway.mockResolvedValue({
      results: [
        { organization_id: 5, guardrail_deleted: 3, spend_deleted: 9 },
        {
          organization_id: 6,
          guardrail_deleted: 4,
          guardrail_capped: true,
          spend_deleted: 0,
          spend_error: "db down",
        },
      ],
    });
    await runDataRetentionPruneAllOrgs();
    expect(mockGateway).toHaveBeenCalledTimes(1);
    expect(mockGateway).toHaveBeenCalledWith("POST", "/internal/retention/purge", {
      timeoutMs: 300_000,
    });
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
    // The spend failure does not mark the guardrail purge failed; it hit the cap.
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 6,
        recordType: "ai_gateway_guardrail_logs",
        deletedCount: 4,
        status: "capped",
        error: null,
      }),
    );
  });

  it("never fails the job when the gateway call fails", async () => {
    mockAllOrgs.mockResolvedValue([]);
    mockGateway.mockRejectedValue(new Error("gateway unreachable"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("records failed runs for both log types of every opted-in org when the gateway call fails", async () => {
    mockAllOrgs.mockResolvedValue([]);
    mockGateway.mockRejectedValue(new Error("gateway unreachable"));
    mockOptedIn.mockResolvedValue([5, 6]);
    await runDataRetentionPruneAllOrgs();
    expect(mockRecord).toHaveBeenCalledTimes(4);
    for (const organizationId of [5, 6]) {
      for (const recordType of ["ai_gateway_guardrail_logs", "ai_gateway_spend_logs"]) {
        expect(mockRecord).toHaveBeenCalledWith({
          organizationId,
          recordType,
          cutoff: null,
          deletedCount: 0,
          status: "failed",
          error: "gateway unreachable",
        });
      }
    }
  });

  it("never fails the job when reading opted-in orgs fails after a gateway failure", async () => {
    mockAllOrgs.mockResolvedValue([]);
    mockGateway.mockRejectedValue(new Error("gateway unreachable"));
    mockOptedIn.mockRejectedValue(new Error("db down"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("keeps going when recording one gateway run fails", async () => {
    mockAllOrgs.mockResolvedValue([]);
    mockGateway.mockResolvedValue({
      results: [{ organization_id: 5, guardrail_deleted: 1, spend_deleted: 2 }],
    });
    mockRecord.mockRejectedValueOnce(new Error("insert failed"));
    await expect(runDataRetentionPruneAllOrgs()).resolves.toBeUndefined();
    expect(mockRecord).toHaveBeenCalledTimes(2);
  });
});
