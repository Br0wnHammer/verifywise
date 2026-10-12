import { runDataRetentionPrune, runDataRetentionPruneAllOrgs } from "../dataRetentionPrune";
import { pruneAuditLedgerBatch } from "../../../../utils/auditLedgerRetention.utils";
import { appendToAuditLedger } from "../../../../utils/auditLedger.utils";
import {
  AUDIT_RECORD_TABLES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  deleteAuditRowsBatch,
  getAuditRetentionMonths,
  recordRetentionRun,
} from "../../../../utils/dataRetention.utils";
import { getAllOrganizationsQuery } from "../../../../utils/organization.utils";

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
}));
jest.mock("../../../../utils/organization.utils", () => ({
  getAllOrganizationsQuery: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("../../../../utils/dataRetention.utils").getAuditCutoff as jest.Mock).mockResolvedValue(
    "2024-06-10 00:00:00+00",
  );
  mockMonths.mockResolvedValue(24);
  mockLedger.mockResolvedValue(0);
  mockTable.mockResolvedValue(0);
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

  it("records a failed run and rethrows on error", async () => {
    mockTable.mockRejectedValueOnce(new Error("boom"));
    await expect(runDataRetentionPrune(1)).rejects.toThrow("boom");
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "boom" }),
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
    expect(mockLedger).toHaveBeenCalledTimes(1);
    expect(mockLedger).toHaveBeenCalledWith(2, "2024-06-10 00:00:00+00", RETENTION_BATCH_SIZE);
  });
});
