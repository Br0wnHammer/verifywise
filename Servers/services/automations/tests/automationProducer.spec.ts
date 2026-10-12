/**
 * @fileoverview Automation Producer Tests
 *
 * Tests for enqueueAutomationAction and schedule* functions.
 *
 * @module tests/automationProducer
 */

jest.mock("bullmq", () => {
  const mockAdd = jest.fn().mockResolvedValue({ id: "job-1" });
  const mockObliterate = jest.fn().mockResolvedValue(undefined);
  const mockUpsertJobScheduler = jest.fn().mockResolvedValue({ id: "job-1" });
  const mockGetJob = jest.fn().mockResolvedValue(undefined);
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: mockAdd,
      obliterate: mockObliterate,
      upsertJobScheduler: mockUpsertJobScheduler,
      getJob: mockGetJob,
    })),
  };
});

jest.mock("../../../database/redis", () => ({
  REDIS_URL: "redis://localhost:6379",
}));

jest.mock("../../../utils/logger/fileLogger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

import {
  enqueueAutomationAction,
  automationQueue,
  scheduleVendorReviewDateNotification,
  schedulePolicyDueSoonNotification,
  scheduleReportNotification,
  schedulePMMHourlyCheck,
  scheduleShadowAiJobs,
  scheduleAgentDiscoverySync,
  scheduleAiDetectionScanCheck,
  scheduleAiGatewayRiskDetection,
  scheduleAiGatewayCacheCleanup,
  scheduleMcpGatewayCleanup,
  scheduleFileExpirySweep,
  scheduleJiraAssetsScheduledSyncCheck,
  enqueueJiraAssetsSyncRun,
  hasPendingJiraAssetsSyncJob,
  BackgroundJobsUnavailableError,
  QUEUE_CALL_TIMEOUT_MS,
} from "../automationProducer";

const mockAdd = automationQueue.add as jest.MockedFunction<typeof automationQueue.add>;
const mockObliterate = automationQueue.obliterate as jest.MockedFunction<
  typeof automationQueue.obliterate
>;
const mockUpsertJobScheduler = automationQueue.upsertJobScheduler as jest.MockedFunction<
  typeof automationQueue.upsertJobScheduler
>;

describe("automationProducer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const expectSchedulerCall = (name: string, data: object, pattern: string, tz?: string) => {
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      name,
      tz ? { pattern, tz } : { pattern },
      expect.objectContaining({
        name,
        data,
        opts: expect.objectContaining({
          removeOnComplete: true,
          removeOnFail: false,
        }),
      }),
    );
  };

  describe("enqueueAutomationAction", () => {
    it("should add a job to the queue", async () => {
      const result = await enqueueAutomationAction("test_action", { key: "value" });

      expect(mockAdd).toHaveBeenCalledWith("test_action", { key: "value" }, {});
      expect(result).toEqual({ id: "job-1" });
    });

    it("should pass options to the queue", async () => {
      await enqueueAutomationAction("test_action", { key: "value" }, { delay: 5000 });

      expect(mockAdd).toHaveBeenCalledWith("test_action", { key: "value" }, { delay: 5000 });
    });
  });

  describe("scheduleVendorReviewDateNotification", () => {
    it("should obliterate queue and add a repeating job", async () => {
      await scheduleVendorReviewDateNotification();

      expect(mockObliterate).toHaveBeenCalledWith({ force: true });
      expectSchedulerCall("send_vendor_notification", { type: "review_date" }, "0 0 * * *");
    });
  });

  describe("schedulePolicyDueSoonNotification", () => {
    it("should add a repeating job at 8 AM daily", async () => {
      await schedulePolicyDueSoonNotification();

      expectSchedulerCall(
        "send_policy_due_soon_notification",
        { type: "policy_due_soon" },
        "0 8 * * *",
      );
    });
  });

  describe("scheduleReportNotification", () => {
    it("should obliterate queue and add a repeating job", async () => {
      await scheduleReportNotification();

      expect(mockObliterate).toHaveBeenCalledWith({ force: true });
      expectSchedulerCall("send_report_notification", { type: "report_notification" }, "0 0 * * *");
    });
  });

  describe("schedulePMMHourlyCheck", () => {
    it("should add a repeating job every hour", async () => {
      await schedulePMMHourlyCheck();

      expectSchedulerCall("pmm_hourly_check", { type: "pmm" }, "0 * * * *");
    });
  });

  describe("scheduleShadowAiJobs", () => {
    it("should schedule 5 shadow AI jobs", async () => {
      await scheduleShadowAiJobs();

      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(5);
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "shadow_ai_daily_rollup",
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "shadow_ai_monthly_rollup",
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "shadow_ai_risk_scoring",
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "shadow_ai_purge_events",
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "ai_gateway_budget_reset",
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  describe("scheduleAgentDiscoverySync", () => {
    it("should add a repeating job every 6 hours", async () => {
      await scheduleAgentDiscoverySync();

      expectSchedulerCall("agent_discovery_sync", { type: "agent_discovery" }, "0 */6 * * *");
    });
  });

  describe("scheduleAiDetectionScanCheck", () => {
    it("should add a repeating job every 5 minutes", async () => {
      await scheduleAiDetectionScanCheck();

      expectSchedulerCall(
        "ai_detection_scheduled_scan_check",
        { type: "ai_detection" },
        "*/5 * * * *",
      );
    });
  });

  describe("scheduleAiGatewayRiskDetection", () => {
    it("should add a repeating job at 6 AM daily", async () => {
      await scheduleAiGatewayRiskDetection();

      expectSchedulerCall("ai_gateway_risk_detection", { type: "ai_gateway_risk" }, "0 6 * * *");
    });
  });

  describe("scheduleAiGatewayCacheCleanup", () => {
    it("should add a repeating job at 3 AM daily", async () => {
      await scheduleAiGatewayCacheCleanup();

      expectSchedulerCall("ai_gateway_cache_cleanup", { type: "ai_gateway_cache" }, "0 3 * * *");
    });
  });

  describe("scheduleMcpGatewayCleanup", () => {
    it("should add a repeating job at 3 AM daily", async () => {
      await scheduleMcpGatewayCleanup();

      expectSchedulerCall("mcp_audit_cleanup", { type: "mcp_gateway" }, "0 3 * * *");
    });
  });

  describe("scheduleFileExpirySweep", () => {
    it("should add a repeating job at 4:30 AM daily without obliterating", async () => {
      await scheduleFileExpirySweep();

      expect(mockObliterate).not.toHaveBeenCalled();
      expectSchedulerCall("file_expiry_sweep", { type: "file_expiry" }, "30 4 * * *");
    });
  });

  describe("enqueueJiraAssetsSyncRun", () => {
    const mockGetJob = automationQueue.getJob as unknown as jest.Mock;
    const payload = { organizationId: 5, triggeredBy: null, syncType: "scheduled" as const };

    beforeEach(() => {
      mockGetJob.mockReset();
      mockGetJob.mockResolvedValue(undefined);
    });

    it("queues one attempt under a fixed per-org job id, removed when done", async () => {
      await expect(enqueueJiraAssetsSyncRun(payload)).resolves.toEqual({
        jobId: "jira-assets-sync-5",
        queued: true,
      });

      expect(mockAdd).toHaveBeenCalledWith("jira_assets_sync_run", payload, {
        jobId: "jira-assets-sync-5",
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    });

    it("does not queue a second job while one is waiting or running", async () => {
      mockGetJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue("waiting") });

      await expect(enqueueJiraAssetsSyncRun(payload)).resolves.toEqual({
        jobId: "jira-assets-sync-5",
        queued: false,
      });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("clears a finished job left behind before queueing", async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      mockGetJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue("failed"), remove });

      await enqueueJiraAssetsSyncRun(payload);

      expect(remove).toHaveBeenCalled();
      expect(mockAdd).toHaveBeenCalled();
    });

    it("reports pending jobs", async () => {
      mockGetJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue("active") });
      await expect(hasPendingJiraAssetsSyncJob(5)).resolves.toBe(true);

      mockGetJob.mockResolvedValue(undefined);
      await expect(hasPendingJiraAssetsSyncJob(5)).resolves.toBe(false);
    });

    it("gives up after QUEUE_CALL_TIMEOUT_MS with BackgroundJobsUnavailableError", async () => {
      jest.useFakeTimers();
      try {
        mockGetJob.mockReturnValue(new Promise(() => undefined)); // Redis never answers
        const pending = enqueueJiraAssetsSyncRun(payload);
        const assertion = expect(pending).rejects.toBeInstanceOf(BackgroundJobsUnavailableError);
        jest.advanceTimersByTime(QUEUE_CALL_TIMEOUT_MS);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });

    it("turns a queue error into BackgroundJobsUnavailableError", async () => {
      mockGetJob.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(enqueueJiraAssetsSyncRun(payload)).rejects.toBeInstanceOf(
        BackgroundJobsUnavailableError,
      );
    });
  });

  describe("scheduleJiraAssetsScheduledSyncCheck", () => {
    it("should add a repeating job every 5 minutes without obliterating", async () => {
      await scheduleJiraAssetsScheduledSyncCheck();

      expect(mockObliterate).not.toHaveBeenCalled();
      expectSchedulerCall("jira_assets_scheduled_sync_check", {}, "*/5 * * * *");
    });
  });
});
