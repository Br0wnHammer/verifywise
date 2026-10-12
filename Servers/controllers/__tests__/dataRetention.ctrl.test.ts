import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn<any>(),
  logSuccess: jest.fn<any>().mockResolvedValue(undefined),
  logFailure: jest.fn<any>().mockResolvedValue(undefined),
}));
jest.mock("../../utils/i18n.utils", () => ({ translateError: jest.fn(() => "err") }));
jest.mock("../../utils/dataRetention.utils", () => ({
  AUDIT_RETENTION_MONTHS: [12, 24, 36, 60, 84, 120],
  countAuditRecordsBefore: jest.fn<any>(),
  getAuditRetentionMonths: jest.fn<any>(),
  getLatestRetentionRuns: jest.fn<any>(),
  setAuditRetentionMonths: jest.fn<any>(),
}));
jest.mock("../../utils/auditLedgerRetention.utils", () => ({
  getLatestLedgerCheckpoint: jest.fn<any>(),
}));
jest.mock("../../utils/auditLedger.utils", () => ({ appendToAuditLedger: jest.fn<any>() }));
jest.mock("../../utils/aiGatewayInternal.utils", () => ({ aiGatewayRequest: jest.fn<any>() }));
jest.mock("../../utils/mrmSettings.utils", () => ({ getMrmOrgSettings: jest.fn<any>() }));
jest.mock("../../utils/fileOrgSettings.utils", () => ({ getFileOrgSettings: jest.fn<any>() }));
jest.mock("../../utils/shadowAiConfig.utils", () => ({ getSettingsQuery: jest.fn<any>() }));
jest.mock("../../utils/logger/logRetention", () => ({
  getServerLogRetentionDays: jest.fn<any>().mockReturnValue(14),
}));

import {
  getDataRetention,
  previewAuditRetention,
  updateAuditRetention,
} from "../dataRetention.ctrl";
import * as retention from "../../utils/dataRetention.utils";
import { getLatestLedgerCheckpoint } from "../../utils/auditLedgerRetention.utils";
import { appendToAuditLedger } from "../../utils/auditLedger.utils";
import { aiGatewayRequest } from "../../utils/aiGatewayInternal.utils";
import { getMrmOrgSettings } from "../../utils/mrmSettings.utils";
import { getFileOrgSettings } from "../../utils/fileOrgSettings.utils";
import { getSettingsQuery } from "../../utils/shadowAiConfig.utils";

const m = (fn: unknown) => fn as jest.MockedFunction<any>;

function createReq(overrides: Record<string, any> = {}): any {
  return {
    userId: 5,
    organizationId: 2,
    role: "Admin",
    t: (k: string) => k,
    body: {},
    query: {},
    ...overrides,
  };
}
function createRes(): any {
  const res: any = {};
  res.status = jest.fn<any>().mockReturnValue(res);
  res.json = jest.fn<any>().mockReturnValue(res);
  return res;
}
const body = (res: any) => res.json.mock.calls[0][0].data;
const row = (res: any, key: string) => body(res).rows.find((r: any) => r.key === key);

describe("dataRetention.ctrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    m(retention.getAuditRetentionMonths).mockResolvedValue(null);
    m(retention.getLatestRetentionRuns).mockResolvedValue({});
    m(getLatestLedgerCheckpoint).mockResolvedValue(null);
    m(getMrmOrgSettings).mockResolvedValue({ retention_months: 25 });
    m(getFileOrgSettings).mockResolvedValue({ default_retention_policy: null });
    m(getSettingsQuery).mockResolvedValue({
      retention_events_days: 30,
      retention_daily_rollups_days: 365,
      retention_alert_history_days: 0,
    });
    m(aiGatewayRequest).mockImplementation(async (_method: string, path: string) => {
      if (path === "/internal/guardrails/settings") {
        return {
          settings: {
            log_retention_days: 45,
            spend_log_retention_days: 120,
            auto_purge_enabled: true,
          },
        };
      }
      return { config: { mcp_audit_retention_days: 60 } };
    });
  });

  describe("getDataRetention", () => {
    it("returns the ten rows in order", async () => {
      const res = createRes();
      await getDataRetention(createReq(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(body(res).rows.map((r: any) => r.key)).toEqual([
        "audit_records",
        "ai_gateway_guardrail_logs",
        "ai_gateway_spend_logs",
        "agent_control_logs",
        "mrm_metrics",
        "evidence_files",
        "shadow_ai_events",
        "shadow_ai_daily_rollups",
        "shadow_ai_alert_history",
        "server_logs",
      ]);
      expect(body(res).auditPrunedThrough).toBeNull();
    });

    it("keeps audit records indefinitely by default and deletes when a period is set", async () => {
      let res = createRes();
      await getDataRetention(createReq(), res);
      expect(row(res, "audit_records")).toMatchObject({ period: null, automaticDeletion: "no" });

      m(retention.getAuditRetentionMonths).mockResolvedValue(24);
      m(retention.getLatestRetentionRuns).mockResolvedValue({
        audit_records: { ran_at: "2026-10-01T00:00:00.000Z", deleted_count: 7, status: "capped" },
      });
      m(getLatestLedgerCheckpoint).mockResolvedValue({
        pruned_through_id: 3,
        anchor_hash: "x",
        cutoff: "2024-10-01T00:00:00.000Z",
      });
      res = createRes();
      await getDataRetention(createReq(), res);
      expect(row(res, "audit_records")).toMatchObject({
        period: { unit: "months", value: 24 },
        automaticDeletion: "yes",
        lastCleanup: { ranAt: "2026-10-01T00:00:00.000Z", deletedCount: 7, status: "capped" },
      });
      expect(body(res).auditPrunedThrough).toEqual({ cutoff: "2024-10-01T00:00:00.000Z" });
    });

    it("reads gateway values and forwards only the signed-in org and role", async () => {
      const res = createRes();
      await getDataRetention(createReq({ organizationId: 9, role: "Admin" }), res);

      expect(row(res, "ai_gateway_guardrail_logs")).toMatchObject({
        period: { unit: "days", value: 45 },
        automaticDeletion: "yes",
      });
      expect(row(res, "ai_gateway_spend_logs").period).toEqual({ unit: "days", value: 120 });
      expect(row(res, "agent_control_logs")).toMatchObject({
        period: { unit: "days", value: 60 },
        source: "deployment",
        deploymentSetting: "MCP_AUDIT_RETENTION_DAYS",
      });
      for (const call of m(aiGatewayRequest).mock.calls) {
        expect(call[2]).toEqual({ organizationId: 9, role: "Admin" });
      }
    });

    it("treats missing gateway fields as 90 days and automatic deletion off", async () => {
      m(aiGatewayRequest).mockImplementation(async (_m: string, path: string) =>
        path === "/internal/guardrails/settings"
          ? { settings: { log_retention_days: 30 } }
          : { config: { mcp_audit_retention_days: 60 } },
      );
      const res = createRes();
      await getDataRetention(createReq(), res);

      expect(row(res, "ai_gateway_spend_logs")).toMatchObject({
        period: { unit: "days", value: 90 },
        automaticDeletion: "no",
      });
    });

    it("marks only the Agent Control row unavailable when its config call fails", async () => {
      m(aiGatewayRequest).mockImplementation(async (_m: string, path: string) => {
        if (path === "/internal/guardrails/settings") return { settings: null };
        throw new Error("404");
      });
      const res = createRes();
      await getDataRetention(createReq(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(row(res, "agent_control_logs").unavailable).toBe(true);
      expect(row(res, "ai_gateway_guardrail_logs").unavailable).toBeUndefined();
      expect(row(res, "ai_gateway_guardrail_logs").period).toEqual({ unit: "days", value: 90 });
    });

    it("marks gateway rows unavailable and still returns 200 when the gateway is down", async () => {
      m(aiGatewayRequest).mockRejectedValue(new Error("ECONNREFUSED"));
      const res = createRes();
      await getDataRetention(createReq(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      for (const key of [
        "ai_gateway_guardrail_logs",
        "ai_gateway_spend_logs",
        "agent_control_logs",
      ]) {
        expect(row(res, key).unavailable).toBe(true);
      }
      expect(row(res, "mrm_metrics").unavailable).toBeUndefined();
    });

    it("builds the MRM, evidence, Shadow AI and server log rows", async () => {
      m(getFileOrgSettings).mockResolvedValue({ default_retention_policy: "3_years" });
      const res = createRes();
      await getDataRetention(createReq(), res);

      expect(row(res, "mrm_metrics")).toMatchObject({
        period: { unit: "months", value: 25 },
        automaticDeletion: "yes",
      });
      expect(row(res, "evidence_files")).toMatchObject({
        period: { unit: "policy", value: "3_years" },
        automaticDeletion: "archive",
      });
      expect(row(res, "shadow_ai_events")).toMatchObject({
        period: { unit: "days", value: 30 },
        automaticDeletion: "yes",
      });
      expect(row(res, "shadow_ai_alert_history")).toMatchObject({
        period: null,
        automaticDeletion: "no",
      });
      expect(row(res, "server_logs")).toMatchObject({
        period: { unit: "days", value: 14 },
        automaticDeletion: "rotate",
        source: "deployment",
        deploymentSetting: "LOG_RETENTION_DAYS",
      });
    });

    it("returns 500 when a database read fails", async () => {
      m(retention.getAuditRetentionMonths).mockRejectedValue(new Error("db"));
      const res = createRes();
      await getDataRetention(createReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe("previewAuditRetention", () => {
    it.each(["abc", "7", "", undefined])("rejects months=%s", async (months) => {
      const res = createRes();
      await previewAuditRetention(createReq({ query: { months } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(retention.countAuditRecordsBefore).not.toHaveBeenCalled();
    });

    it("returns the count for an allowed period", async () => {
      m(retention.countAuditRecordsBefore).mockResolvedValue(42);
      const res = createRes();
      await previewAuditRetention(createReq({ query: { months: "24" } }), res);
      expect(retention.countAuditRecordsBefore).toHaveBeenCalledWith(2, 24);
      expect(body(res)).toEqual({ count: 42 });
    });
  });

  describe("updateAuditRetention", () => {
    it.each([[7], ["24"], [undefined], [0]])("rejects months=%p", async (months) => {
      const res = createRes();
      await updateAuditRetention(createReq({ body: months === undefined ? {} : { months } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(retention.setAuditRetentionMonths).not.toHaveBeenCalled();
    });

    it("rejects a non-admin", async () => {
      const res = createRes();
      await updateAuditRetention(createReq({ role: "Editor", body: { months: 24 } }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(retention.setAuditRetentionMonths).not.toHaveBeenCalled();
    });

    it("saves a period and records the change in the ledger", async () => {
      m(retention.getAuditRetentionMonths).mockResolvedValue(null);
      const res = createRes();
      await updateAuditRetention(createReq({ body: { months: 36 } }), res);

      expect(retention.setAuditRetentionMonths).toHaveBeenCalledWith(2, 36, 5);
      expect(appendToAuditLedger).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 2,
          entryType: "event_log",
          eventType: "Update",
          entityType: "data_retention",
          description: expect.stringContaining("Indefinitely"),
        }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(body(res)).toEqual({ months: 36 });
    });

    it("accepts null to keep records indefinitely", async () => {
      m(retention.getAuditRetentionMonths).mockResolvedValue(24);
      const res = createRes();
      await updateAuditRetention(createReq({ body: { months: null } }), res);
      expect(retention.setAuditRetentionMonths).toHaveBeenCalledWith(2, null, 5);
      expect(body(res)).toEqual({ months: null });
    });

    it("still succeeds when the ledger append fails", async () => {
      m(appendToAuditLedger).mockRejectedValue(new Error("ledger"));
      const res = createRes();
      await updateAuditRetention(createReq({ body: { months: 12 } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
